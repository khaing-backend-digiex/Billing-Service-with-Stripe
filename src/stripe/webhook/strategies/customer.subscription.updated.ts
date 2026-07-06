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

const EVENT_TYPE = "customer.subscription.updated";

const STATUS_UNPAID: Stripe.Subscription.Status = "unpaid";
const STATUS_CANCELED: Stripe.Subscription.Status = "canceled";
const REASON_PAYMENT_FAILED: Stripe.Subscription.CancellationDetails.Reason =
  "payment_failed";

@Injectable()
export class CustomerSubscriptionUpdatedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(CustomerSubscriptionUpdatedStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly freePlanDowngrade: FreePlanDowngradeService,
    private readonly subscriptionSyncService: SubscriptionSyncService,
  ) { }

  canHandle(eventType: string): boolean {
    return eventType === EVENT_TYPE;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const sub = event.data.object as Stripe.Subscription;
    this.logger.log(`${EVENT_TYPE}: ${sub.id} → ${sub.status}`);


    const isFinalPaymentFailure =
      sub.status === STATUS_UNPAID ||
      (sub.status === STATUS_CANCELED &&
        sub.cancellation_details?.reason === REASON_PAYMENT_FAILED);

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
              reason: REASON_PAYMENT_FAILED,
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

    await this.freePlanDowngrade.downgradeToFree(subscription, sub, REASON_PAYMENT_FAILED);
  }
}
