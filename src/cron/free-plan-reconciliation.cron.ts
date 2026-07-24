import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
  CreditTransactionType,
  ReferenceType,
  SubscriptionStatus,
  User,
} from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { StripeService } from "../stripe/stripe.service";
import { PaymentSubscription } from "../payments/types/payment.types";
import { UsersService } from "../users/users.service";
import { SubscriptionSyncService } from "../stripe/sync/subscription-sync.service";
import { PaidInvoiceSyncService } from "../stripe/sync/paid-invoice-sync.service";
import { CreditService } from "../credits/credit.service";
import { creditKey } from "../credits/credit.types";

const GRACE_MS = 15 * 60_000;
const BATCH_SIZE = 50;

enum ReconcileOutcome {
  CREATED = "created",
  HEALED = "healed",
  SKIPPED = "skipped",
  FAILED = "failed",
}

@Injectable()
export class FreePlanReconciliationCron {
  private readonly logger = new Logger(FreePlanReconciliationCron.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly usersService: UsersService,
    private readonly subscriptionSync: SubscriptionSyncService,
    private readonly paidInvoiceSync: PaidInvoiceSyncService,
    private readonly prisma: PrismaService,
    private readonly creditService: CreditService,
  ) { }

  @Cron(CronExpression.EVERY_HOUR)
  async reconcile(): Promise<void> {
    await this.reconcileOnboarding();
    await this.reconcileMissingSettlement();
  }

  private async reconcileOnboarding(): Promise<void> {
    const users = await this.usersService.findIncompleteOnboardingUsers({
      createdBefore: new Date(Date.now() - GRACE_MS),
      limit: BATCH_SIZE,
    });

    if (users.length === 0) return;
    this.logger.log(`Free plan reconciliation: ${users.length} user(s) incomplete`);

    const outcomes = Object.values(ReconcileOutcome);
    const tally = new Map(outcomes.map((outcome) => [outcome, 0]));

    for (const user of users) {
      const outcome = await this.reconcileUser(user);
      tally.set(outcome, tally.get(outcome)! + 1);
    }

    const summary = outcomes
      .map((outcome) => `${outcome}=${tally.get(outcome)}`)
      .join(" ");
    const failed = tally.get(ReconcileOutcome.FAILED)!;

    if (failed > 0) {
      this.logger.warn(`Free plan reconciliation done: ${summary}`);
    } else {
      this.logger.log(`Free plan reconciliation done: ${summary}`);
    }
  }

  private async reconcileMissingSettlement(): Promise<void> {
    const stuck = await this.prisma.$queryRaw<
      { id: string; providerSubscriptionId: string }[]
    >`
      SELECT s.id, s."providerSubscriptionId"
      FROM "Subscription" s
      JOIN "PricingOption" po ON po.id = s."pricingOptionId"
      JOIN "CreditPolicy" cp ON cp."planId" = po."planId"
      WHERE s.status = ${SubscriptionStatus.ACTIVE}::"SubscriptionStatus"
        AND s."providerSubscriptionId" IS NOT NULL
        AND s."currentPeriodStart" < ${new Date(Date.now() - GRACE_MS)}
        AND cp."creditAmount" > 0
        AND NOT EXISTS (
          SELECT 1 FROM "CreditTransaction" ct
          WHERE ct."referenceId" = s.id
            AND ct.type = ${CreditTransactionType.RENEWAL}::"CreditTransactionType"
            AND ct."referenceType" = ${ReferenceType.SUBSCRIPTION}::"ReferenceType"
            AND ct."createdAt" >= s."currentPeriodStart"
        )
      ORDER BY s."currentPeriodStart" ASC
      LIMIT ${BATCH_SIZE}
    `;

    if (stuck.length === 0) return;

    this.logger.warn(
      `Missing settlement: ${stuck.length} active subscription(s) never granted credits for the current period`,
    );

    let healed = 0;
    for (const sub of stuck) {
      try {
        const latestPaid = await this.stripeService.getLatestPaidInvoice(
          sub.providerSubscriptionId!,
        );

        if (!latestPaid) {
          this.logger.warn(
            `Subscription ${sub.id}: no paid invoice on Stripe – nothing to settle`,
          );
          continue;
        }

        await this.paidInvoiceSync.applyPaidInvoice(latestPaid, sub.id);
        healed += 1;
        this.logger.log(
          `Subscription ${sub.id}: settled from Stripe invoice ${latestPaid.id}`,
        );
      } catch (err) {
        this.logger.error(
          `Missing-settlement heal failed for subscription ${sub.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    this.logger.log(`Missing settlement done: healed=${healed}/${stuck.length}`);
  }

  private async reconcileUser(user: User): Promise<ReconcileOutcome> {
    try {
      const customerId = await this.stripeService.ensureValidCustomerId(user);
      const activeSub = await this.stripeService.findActiveSubscription(customerId);

      if (activeSub) {
        return this.healFromStripe(user, activeSub);
      }

      const freePlan = await this.prisma.plan.findFirst({
        where: { isFree: true },
        include: { pricingOptions: true, creditPolicy: true },
      });
      const freeOption = freePlan?.pricingOptions[0];

      if (!freeOption) {
        this.logger.warn(
          `User ${user.id}: free plan is not configured – no subscription created`,
        );
        return ReconcileOutcome.SKIPPED;
      }

      await this.prisma.subscription.create({
        data: {
          userId: user.id,
          productId: freeOption.productId,
          pricingOptionId: freeOption.id,
          status: 'ACTIVE',
          billingMode: 'NONE',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(new Date().setFullYear(new Date().getFullYear() + 100)),
          nextCreditResetAt: new Date(),
        },
      });

      this.logger.log(`User ${user.id}: free subscription created in local DB`);
      return ReconcileOutcome.CREATED;
    } catch (err) {
      this.logger.error(
        `Reconciliation failed for user ${user.id}: ${err instanceof Error ? err.message : err}`,
      );
      return ReconcileOutcome.FAILED;
    }
  }

  private async healFromStripe(
    user: User,
    activeSub: PaymentSubscription,
  ): Promise<ReconcileOutcome> {
    this.logger.warn(
      `User ${user.id}: active Stripe subscription ${activeSub.id} has no local row – healing from Stripe`,
    );

    const local = await this.subscriptionSync.syncFromStripe(activeSub);
    if (!local) {
      this.logger.warn(
        `User ${user.id}: cannot sync Stripe subscription ${activeSub.id} into a local row`,
      );
      return ReconcileOutcome.SKIPPED;
    }

    const latestPaid = await this.stripeService.getLatestPaidInvoice(activeSub.id);
    if (latestPaid) {
      await this.paidInvoiceSync.applyPaidInvoice(latestPaid, local.id);
    }

    return ReconcileOutcome.HEALED;
  }
}