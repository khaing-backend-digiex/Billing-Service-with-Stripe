import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { SubscriptionStatus, SubscriptionEventType } from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";

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

  constructor(private readonly prisma: PrismaService) {}
  
  private readonly customerSubcriptionUpdated="customer.subscription.updated";
  canHandle(eventType: string): boolean {
    return eventType === this.customerSubcriptionUpdated;
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
      const subscription = await tx.subscription.findFirst({
        where: { providerSubscriptionId: sub.id },
      });

      if (!subscription) {
        this.logger.error(`No local subscription found for Stripe subscription ${sub.id}`);
        return;
      }

      const previousStatus = subscription.status;

      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status: newStatus,
          ...(sub.trial_end !== null && sub.trial_end !== undefined
            ? { trialEnd: new Date(sub.trial_end * 1000) }
            : {}),
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
