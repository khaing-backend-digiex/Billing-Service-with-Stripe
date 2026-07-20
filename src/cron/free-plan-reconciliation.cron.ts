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

  @Cron(CronExpression.EVERY_MINUTE)
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
    // Bằng chứng "đã cấp credit cho kỳ này" là SỔ, không phải số dư. Điều kiện sổ phải nằm
    // TRONG query, không được lọc sau khi đã take() — nếu không cron chết đói.
    //
    // Bản cũ take(50) trên bộ lọc số dư rồi mới đối chiếu sổ: người tiêu hết credit (số dư
    // 0 nhưng CÓ bút toán) là false positive vĩnh viễn, luôn chiếm chỗ trong batch. Dev A
    // đã bỏ điều kiện `subscriptionCreditsRemaining = 0` (đúng — cột đó chết ở PR4), nhưng
    // vì bộ lọc sổ vẫn nằm sau take() nên việc bỏ đó làm mọi sub ACTIVE quá grace đều
    // thành candidate: rộng hơn trước, và sub kẹt thật càng khó lọt vào 50 chỗ. Không có
    // orderBy nên thứ tự còn do DB quyết.
    //
    // Bằng chứng "đã cấp credit cho kỳ này" là SỔ, không phải số dư. Điều kiện sổ phải nằm
    // TRONG query, không được lọc sau khi đã take() — nếu không cron chết đói.
    //
    // `ct.referenceId = s.id` giờ mới thật sự đúng: trước đây invoice.paid ghi
    // referenceId = invoice.id (event) thay vì subscription.id (entity), nên mọi sub settle
    // qua đường gia hạn bình thường đều vô hình với NOT EXISTS này và kẹt vĩnh viễn.
    // Migration 20260717000000 đã sửa cả bên ghi lẫn dữ liệu cũ — đó là thứ chữa cron, chứ
    // không phải đổi bảng đi hỏi.
    //
    // TODO(C6): hỏi CreditGrant(sourceRef = s.id) thì đúng ngữ nghĩa hơn — sourceRef là
    // identity, còn bút toán neo theo event. NHƯNG chưa được: đã đo trên dev, đếm theo grant
    // ra 71 sub kẹt so với 4 theo sổ, vì 196/201 bút toán RENEWAL có grantId NULL — lịch sử
    // trước PR2, lúc CreditGrant chưa tồn tại. Đếm theo grant coi toàn bộ lịch sử đó là
    // "chưa từng cấp" và làm batch 50 đầy rác, đúng kiểu starvation C4 đã chữa.
    // Điều kiện để chuyển: mọi bút toán đều có grant (PR4 siết grantId NOT NULL) — chính là
    // invariant `npm run db:doctor` đang đếm.
    //
    // Phải là raw SQL: điều kiện sổ so `referenceId` với id của CHÍNH sub đang xét và
    // `createdAt` với `currentPeriodStart` của chính nó. Prisma không tham chiếu chéo cột
    // của hàng ngoài trong nested filter được.
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

      const nextCreditResetAt = new Date();
      nextCreditResetAt.setMonth(nextCreditResetAt.getMonth() + 1); 

      const sub = await this.prisma.subscription.create({
        data: {
          userId: user.id,
          productId: freeOption.productId,
          pricingOptionId: freeOption.id,
          status: 'ACTIVE',
          billingMode: 'NONE',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(new Date().setFullYear(new Date().getFullYear() + 100)),
          nextCreditResetAt: nextCreditResetAt,
        },
      });

      const policy = freePlan.creditPolicy;
      if (policy) {
        await this.creditService.resetSubscriptionAllowance({
          userId: user.id,
          productId: freeOption.productId,
          amount: policy.creditAmount,
          grantDescription: `Initial Free plan credits (Reconciliation)`,
          revokeDescription: `Reset`,
          subscriptionId: sub.id,
          idempotencyKey: creditKey.subscriptionReset(sub.id, sub.nextCreditResetAt),
          expiresAt: sub.nextCreditResetAt, 
        });
      }

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