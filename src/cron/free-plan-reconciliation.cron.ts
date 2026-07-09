import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { User } from "@prisma/client";
import { StripeService } from "../stripe/stripe.service";
import { StripeSubscription } from "../stripe/adapter/payment-adapter.interface";
import { UsersService } from "../users/users.service";
import { SubscriptionSyncService } from "../stripe/sync/subscription-sync.service";
import { PaidInvoiceSyncService } from "../stripe/sync/paid-invoice-sync.service";

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
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async reconcile(): Promise<void> {
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

  private async reconcileUser(user: User): Promise<ReconcileOutcome> {
    try {
      const customerId = await this.usersService.ensureValidStripeCustomerId(user);
      const activeSub = await this.stripeService.findActiveSubscription(customerId);

      if (activeSub) {
        return this.healFromStripe(user, activeSub);
      }

      const freeSub = await this.stripeService.subscribeToFreePlan(customerId);
      if (!freeSub) {
        this.logger.warn(
          `User ${user.id}: free plan is not configured – no subscription created`,
        );
        return ReconcileOutcome.SKIPPED;
      }

      this.logger.log(`User ${user.id}: free subscription ${freeSub.id} created`);
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
    activeSub: StripeSubscription,
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
      await this.paidInvoiceSync.applyPaidInvoice(latestPaid, activeSub.id);
    }

    return ReconcileOutcome.HEALED;
  }
}
