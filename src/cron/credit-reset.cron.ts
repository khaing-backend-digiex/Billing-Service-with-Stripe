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

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleCreditReset(): Promise<void> {
    const now = new Date();
    this.logger.log(`⏰ Credit reset cron started at ${now.toISOString()}`);

    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        nextCreditResetAt: { lte: now },
        currentPeriodEnd: { gt: now },
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
      let newNextReset = addCalendarMonths(
        subscription.nextCreditResetAt,
        resetMonths,
      );

      while (newNextReset <= now) {
        newNextReset = addCalendarMonths(newNextReset, resetMonths);
      }

      if (newNextReset > subscription.currentPeriodEnd) {
        this.logger.log(
          `Skipping subscription ${subscription.id}: next reset ${newNextReset.toISOString()} exceeds period end ${subscription.currentPeriodEnd.toISOString()}. Will be handled by invoice.paid on renewal.`,
        );
        continue;
      }

      try {
        const didReset = await this.prisma.$transaction(async (tx) => {
          const updated = await tx.subscription.updateMany({
            where: {
              id: subscription.id,
              status: SubscriptionStatus.ACTIVE,
              nextCreditResetAt: subscription.nextCreditResetAt,
            },
            data: {
              subscriptionCreditsRemaining: plan.renewalCredits,
              nextCreditResetAt: newNextReset,
            },
          });

          if (updated.count === 0) {
            this.logger.log(
              `Skipping subscription ${subscription.id}: already reset by another worker or invoice.paid.`,
            );
            return false;
          }

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

          return true;
        });

        if (didReset) {
          this.logger.log(
            `Reset credits for subscription ${subscription.id}: +${plan.renewalCredits} credits, next reset: ${newNextReset.toISOString()}`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Failed to reset credits for subscription ${subscription.id}: ${error}`,
        );
      }
    }

    this.logger.log(`Credit reset cron finished.`);
  }
}
