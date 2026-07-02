import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
  SubscriptionStatus,
  CreditTransactionType,
  ReferenceType,
  SubscriptionEventType,
} from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { addCalendarMonths } from "../common/utils/date.util";

@Injectable()
export class CreditResetCronService {
  private readonly logger = new Logger(CreditResetCronService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Chạy mỗi ngày lúc 00:00 UTC.
   * Quét tất cả subscription ACTIVE có nextCreditResetAt <= now,
   * reset credit và đẩy nextCreditResetAt sang tháng tiếp theo.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleCreditReset(): Promise<void> {
    const now = new Date();
    this.logger.log(`⏰ Credit reset cron started at ${now.toISOString()}`);

    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        nextCreditResetAt: { lte: now },
      },
      include: {
        pricingOption: {
          include: {
            plan: true,
          },
        },
      },
    });

    if (subscriptions.length === 0) {
      this.logger.log("No subscriptions due for credit reset.");
      return;
    }

    this.logger.log(
      `Found ${subscriptions.length} subscription(s) due for credit reset.`,
    );

    for (const subscription of subscriptions) {
      const plan = subscription.pricingOption.plan;
      const resetMonths = Math.max(1, Math.round(plan.resetIntervalDay / 30));
      const newNextReset = addCalendarMonths(
        subscription.nextCreditResetAt,
        resetMonths,
      );

      // Guard: Nếu mốc reset tiếp theo vượt qua currentPeriodEnd,
      // bỏ qua — để invoice.paid xử lý khi Stripe renew.
      if (newNextReset > subscription.currentPeriodEnd) {
        this.logger.log(
          `Skipping subscription ${subscription.id}: next reset ${newNextReset.toISOString()} exceeds period end ${subscription.currentPeriodEnd.toISOString()}. Will be handled by invoice.paid on renewal.`,
        );
        continue;
      }

      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.subscription.update({
            where: { id: subscription.id },
            data: {
              subscriptionCreditsRemaining: plan.renewalCredits,
              nextCreditResetAt: newNextReset,
            },
          });

          await tx.creditTransaction.create({
            data: {
              userId: subscription.userId,
              type: CreditTransactionType.RENEWAL,
              amount: plan.renewalCredits,
              description: `Credits reset – ${plan.name} (monthly cycle)`,
              referenceType: ReferenceType.SUBSCRIPTION,
              referenceId: subscription.id,
            },
          });

          await tx.subscriptionEvent.create({
            data: {
              subscriptionId: subscription.id,
              type: SubscriptionEventType.RENEWED,
              metadata: {
                reason: "cron_credit_reset",
                creditsGranted: plan.renewalCredits,
                nextResetAt: newNextReset.toISOString(),
              },
            },
          });
        });

        this.logger.log(
          `✅ Reset credits for subscription ${subscription.id}: +${plan.renewalCredits} credits, next reset: ${newNextReset.toISOString()}`,
        );
      } catch (error) {
        this.logger.error(
          `❌ Failed to reset credits for subscription ${subscription.id}: ${error}`,
        );
      }
    }

    this.logger.log(`⏰ Credit reset cron finished.`);
  }
}
