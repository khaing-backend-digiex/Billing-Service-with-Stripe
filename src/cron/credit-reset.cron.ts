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
import { CreditService } from "../credits/credit.service";
import { creditKey } from "../credits/credit.types";
import { resolveResetMonths } from "../credits/credit-policy.util";
import { SUBSCRIPTION_EVENT_REASON } from "../common/constants/subscription-event.constants";

@Injectable()
export class CreditResetCronService {
  private readonly logger = new Logger(CreditResetCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creditService: CreditService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleCreditReset(): Promise<void> {
    const now = new Date();
    this.logger.log(`Credit reset cron started at ${now.toISOString()}`);

    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        nextCreditResetAt: { lte: now },
        currentPeriodEnd: { gt: now },
      },
      include: {
        pricingOption: {
          include: {
            plan: {
              include: { creditPolicy: true }
            },
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
      const plan = subscription.pricingOption.plan as any;
      const resetMonths = resolveResetMonths(plan.creditPolicy);
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
              nextCreditResetAt: newNextReset,
            },
          });

          if (updated.count === 0) {
            this.logger.log(
              `Skipping subscription ${subscription.id}: already reset by another worker or invoice.paid.`,
            );
            return false;
          }

          await this.creditService.resetSubscriptionAllowance(
            {
              userId: subscription.userId,
              productId: plan.productId,
              amount: plan.creditPolicy?.creditAmount ?? 0,
              grantDescription: `Credits reset – ${plan.name} (monthly cycle)`,
              revokeDescription: `Unused credits expired before monthly reset – ${plan.name}`,
              subscriptionId: subscription.id,
              idempotencyKey: creditKey.subscriptionReset(
                subscription.id,
                subscription.nextCreditResetAt,
              ),
              expiresAt: newNextReset,
            },
            tx,
          );

          await tx.subscriptionEvent.create({
            data: {
              subscriptionId: subscription.id,
              type: SubscriptionEventType.RENEWED,
              metadata: {
                reason: SUBSCRIPTION_EVENT_REASON.CRON_CREDIT_RESET,
                creditsGranted: plan.creditPolicy?.creditAmount ?? 0,
                nextResetAt: newNextReset.toISOString(),
              },
            },
          });

          return true;
        });

        if (didReset) {
          this.logger.log(
            `Reset credits for subscription ${subscription.id}: +${plan.creditPolicy?.creditAmount ?? 0} credits, next reset: ${newNextReset.toISOString()}`,
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
