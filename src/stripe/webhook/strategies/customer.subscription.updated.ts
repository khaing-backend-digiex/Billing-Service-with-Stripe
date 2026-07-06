import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  SubscriptionStatus,
  SubscriptionEventType,
  CreditTransactionType,
  ReferenceType,
} from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { FreePlanDowngradeService } from "../free-plan-downgrade.service";
import { SubscriptionSyncService } from "../../sync/subscription-sync.service";

@Injectable()
export class CustomerSubscriptionUpdatedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(CustomerSubscriptionUpdatedStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly freePlanDowngrade: FreePlanDowngradeService,
    private readonly subscriptionSyncService: SubscriptionSyncService,
    private readonly pricingService: PricingService,
  ) { }

  private readonly customerSubscriptionUpdated = "customer.subscription.updated";
  canHandle(eventType: string): boolean {
    return eventType === this.customerSubscriptionUpdated;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const sub = event.data.object as Stripe.Subscription;
    this.logger.log(`customer.subscription.updated: ${sub.id} → ${sub.status}`);

    
    const isFinalPaymentFailure =
      sub.status === "unpaid" ||
      (sub.status === "canceled" && sub.cancellation_details?.reason === "payment_failed");

    if (isFinalPaymentFailure) {
      await this.expireSubscription(sub);
      return;
    }

    // syncFromStripe tự map status (và trả null nếu status/plan không hợp lệ).
    const previousSubscription = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: sub.id },
    });
    const previousStatus = previousSubscription?.status;

    const subscription = await this.subscriptionSyncService.syncFromStripe(sub);
    if (!subscription) {
      return;
    }

    if (
      previousStatus === SubscriptionStatus.PAST_DUE &&
      subscription.status === SubscriptionStatus.ACTIVE
    ) {
      await this.prisma.subscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: SubscriptionEventType.PAYMENT_RECOVERED,
          metadata: {
            stripeSubscriptionId: sub.id,
          },
        },
      });

      this.logger.log(
        `Payment recovered: subscription ${subscription.id} → ACTIVE`,
      );
    }
  }

  private async expireSubscription(sub: Stripe.Subscription): Promise<void> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: sub.id },
      include: { pricingOption: true },
    });

    if (!subscription) {
      this.logger.error(`No local subscription found for Stripe subscription ${sub.id}`);
      return;
    }

   
    if (subscription.status !== SubscriptionStatus.EXPIRED) {
      await this.prisma.$transaction([
        this.prisma.subscription.update({
          where: { id: subscription.id },
          data: {
            status: SubscriptionStatus.EXPIRED,
            subscriptionCreditsRemaining: 0,
          },
        }),
        this.prisma.subscriptionEvent.create({
          data: {
            subscriptionId: subscription.id,
            type: SubscriptionEventType.EXPIRED,
            metadata: {
              stripeSubscriptionId: sub.id,
              stripeStatus: sub.status,
              reason: "payment_failed",
            },
          },
        }),
        
        ...(subscription.subscriptionCreditsRemaining > 0
          ? [
              this.prisma.creditTransaction.create({
                data: {
                  userId: subscription.userId,
                  type: CreditTransactionType.EXPIRATION,
                  amount: -subscription.subscriptionCreditsRemaining,
                  description: "Credits forfeited – subscription expired (payment failed)",
                  referenceType: ReferenceType.SUBSCRIPTION,
                  referenceId: subscription.id,
                },
              }),
            ]
          : []),
      ]);

      this.logger.log(
        `Subscription ${subscription.id} EXPIRED after exhausted payment retries (stripe status: ${sub.status})`,
      );
    } else {
      this.logger.log(`Subscription ${subscription.id} already EXPIRED`);
    }

    await this.freePlanDowngrade.downgradeToFree(subscription, sub, "payment_failed");
  }
}
