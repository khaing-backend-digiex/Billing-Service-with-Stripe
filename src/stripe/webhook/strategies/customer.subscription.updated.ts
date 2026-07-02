import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { SubscriptionStatus, SubscriptionEventType } from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { PricingService } from "../../../pricing/pricing.service";

const STRIPE_STATUS_MAP: Record<string, SubscriptionStatus> = {
  active: SubscriptionStatus.ACTIVE,
  past_due: SubscriptionStatus.PAST_DUE,
  canceled: SubscriptionStatus.CANCELLED,
  unpaid: SubscriptionStatus.PAST_DUE,
  trialing: SubscriptionStatus.TRIALING,
  paused: SubscriptionStatus.PAUSED,
  incomplete: SubscriptionStatus.PAST_DUE,
  incomplete_expired: SubscriptionStatus.EXPIRED,
};

@Injectable()
export class CustomerSubscriptionUpdatedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(CustomerSubscriptionUpdatedStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
  ) {}
  
  private readonly customerSubscriptionUpdated="customer.subscription.updated";
  canHandle(eventType: string): boolean {
    return eventType === this.customerSubscriptionUpdated;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const sub = event.data.object as Stripe.Subscription;
    this.logger.log(`customer.subscription.updated: ${sub.id} → ${sub.status}`);

    const newStatus = STRIPE_STATUS_MAP[sub.status];
    if (!newStatus) {
      this.logger.error(`Unknown Stripe subscription status: "${sub.status}"`);
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      let subscription = await tx.subscription.findFirst({
        where: { providerSubscriptionId: sub.id },
      });

      if (!subscription) {
        // Chờ 2 giây để nhường đường cho sự kiện created chạy xong (Race condition fix)
        this.logger.warn(`Subscription ${sub.id} not found, waiting 2s for created event...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        subscription = await tx.subscription.findFirst({
          where: { providerSubscriptionId: sub.id },
        });
      }

      if (!subscription) {
        this.logger.error(`No local subscription found for Stripe subscription ${sub.id}`);
        throw new Error(`Race condition: subscription ${sub.id} not found yet.`);
      }

      const previousStatus = subscription.status;
      const previousPricingOptionId = subscription.pricingOptionId;
      
      let newPricingOptionId = previousPricingOptionId;
      
      const priceId = sub.items.data[0]?.price?.id;
      if (priceId) {
        const pricingOption = await this.pricingService.findByProviderPriceId(priceId);
        if (pricingOption) {
          newPricingOptionId = pricingOption.id;
        }
      }

      const currentPeriodStart = sub.current_period_start ? new Date(sub.current_period_start * 1000) : new Date();
      let currentPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      if (newStatus === SubscriptionStatus.CANCELLED && sub.canceled_at) {
        currentPeriodEnd = new Date(sub.canceled_at * 1000);
      }


      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status: newStatus,
          autoRenew: !sub.cancel_at_period_end,
          pricingOptionId: newPricingOptionId,
          ...(sub.trial_end !== null && sub.trial_end !== undefined
            ? { trialEnd: new Date(sub.trial_end * 1000) }
            : {}),
          cancelledAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
          currentPeriodStart: currentPeriodStart,
          currentPeriodEnd: currentPeriodEnd,
        },
      });

      if (previousStatus === SubscriptionStatus.PAST_DUE && newStatus === SubscriptionStatus.ACTIVE) {
        await tx.subscriptionEvent.create({
          data: {
            subscriptionId: subscription.id,
            type: SubscriptionEventType.PAYMENT_RECOVERED,
            metadata: { stripeSubscriptionId: sub.id },
          },
        });
        this.logger.log(`Payment recovered: subscription ${subscription.id} → ACTIVE`);
      }
    });
  }
}
