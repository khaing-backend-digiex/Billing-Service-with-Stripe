import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
  Prisma,
  SubscriptionStatus,
  CreditTransactionType,
  ReferenceType,
} from "@prisma/client";
import { PrismaService } from "../database/prisma.service";

const DAY_MS = 86_400_000;

type SubscriptionWithPlan = Prisma.SubscriptionGetPayload<{
  include: { pricingOption: { include: { plan: true; billingCycle: true } } };
}>;

/**
 * Sweep mỗi giờ: reset credit cho subscription ACTIVE có nextCreditResetAt đã
 * quá hạn, vẫn đang TRONG chu kỳ thanh toán (currentPeriodEnd > now) và có
 * chu kỳ credit NGẮN HƠN chu kỳ billing (resetIntervalDay < durationDay —
 * tức annual plan reset credit hàng tháng). Plan monthly/free (2 chu kỳ bằng
 * nhau) được cấp credit bởi invoice.paid nên job này bỏ qua, tránh reset sớm
 * và ghi trùng CreditTransaction khi tháng dương lịch dài hơn resetIntervalDay.
 * Mỗi mốc reset chỉ cấp đúng 1 lần (optimistic lock trên nextCreditResetAt cũ).
 *
 * Timestamp của CreditTransaction là thời điểm job THỰC SỰ xử lý (createdAt
 * default now) — sau downtime sẽ trễ hơn mốc anniversary, không backdate.
 * Chỉ có lịch reset (nextCreditResetAt) là luôn cộng dồn từ mốc CŨ để bám
 * đúng ngày bắt đầu subscription (start 25/06 → reset 25/07, 25/08…).
 */
@Injectable()
export class CreditResetService {
  private readonly logger = new Logger(CreditResetService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async resetDueCredits(): Promise<void> {
    const now = new Date();

    const overdue = await this.prisma.subscription.findMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        nextCreditResetAt: { lte: now },
        currentPeriodEnd: { gt: now },
      },
      include: { pricingOption: { include: { plan: true, billingCycle: true } } },
    });

    // Prisma không so sánh được 2 cột trong where → lọc ở JS:
    // chỉ xử lý plan có chu kỳ credit ngắn hơn chu kỳ billing.
    const due = overdue.filter(
      (s) => s.pricingOption.plan.resetIntervalDay < s.pricingOption.billingCycle.durationDay,
    );

    if (due.length === 0) return;
    this.logger.log(`Credit reset sweep: ${due.length} subscription(s) due`);

    for (const subscription of due) {
      try {
        await this.resetOne(subscription, now);
      } catch (error) {
        // Lỗi 1 subscription không được chặn các subscription còn lại;
        // lần sweep sau sẽ tự retry vì nextCreditResetAt vẫn <= now.
        this.logger.error(
          `Credit reset failed for subscription ${subscription.id}: ${error}`,
        );
      }
    }
  }

  private async resetOne(
    subscription: SubscriptionWithPlan,
    now: Date,
  ): Promise<void> {
    const plan = subscription.pricingOption.plan;
    const nextResetAt = this.advanceFromAnchor(
      subscription.nextCreditResetAt,
      plan.resetIntervalDay,
      now,
    );

    await this.prisma.$transaction(async (tx) => {
      // Optimistic lock trên nextCreditResetAt cũ: nhiều instance cùng chạy
      // cron thì chỉ instance đầu tiên match → không double-grant.
      const { count } = await tx.subscription.updateMany({
        where: {
          id: subscription.id,
          nextCreditResetAt: subscription.nextCreditResetAt,
          status: SubscriptionStatus.ACTIVE,
        },
        data: {
          subscriptionCreditsRemaining: plan.renewalCredits,
          nextCreditResetAt: nextResetAt,
        },
      });

      if (count === 0) {
        this.logger.log(
          `Subscription ${subscription.id} already reset by another run – skipping`,
        );
        return;
      }

      await tx.creditTransaction.create({
        data: {
          userId: subscription.userId,
          type: CreditTransactionType.RENEWAL,
          amount: plan.renewalCredits,
          description: `Monthly credit reset – ${plan.name}`,
          referenceType: ReferenceType.SUBSCRIPTION,
          referenceId: subscription.id,
        },
      });
    });

    this.logger.log(
      `Credits reset: subscription=${subscription.id} +${plan.renewalCredits} (${plan.name}), next reset ${nextResetAt.toISOString()}`,
    );
  }

  /**
   * Cộng dồn interval từ mốc reset cũ cho tới khi vượt qua now.
   * App downtime nhiều kỳ liền → chỉ cấp credit 1 lần (credit là reset,
   * không cộng dồn) nhưng mốc kế tiếp vẫn giữ đúng ngày anniversary.
   */
  private advanceFromAnchor(anchor: Date, intervalDay: number, now: Date): Date {
    const intervalMs = intervalDay * DAY_MS;
    let next = new Date(anchor.getTime() + intervalMs);
    while (next <= now) {
      next = new Date(next.getTime() + intervalMs);
    }
    return next;
  }
}
