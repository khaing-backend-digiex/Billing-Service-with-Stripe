import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { SubscriptionStatus, SubscriptionEventType } from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";

@Injectable()
export class CustomerSubscriptionDeletedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(CustomerSubscriptionDeletedStrategy.name);

  constructor(private readonly prisma: PrismaService) {}
  
  private readonly customerSubcriptionDeleted = "customer.subscription.deleted"
  canHandle(eventType: string): boolean {
    return eventType === this.customerSubcriptionDeleted;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const sub = event.data.object as Stripe.Subscription;
    this.logger.log(`customer.subscription.deleted: ${sub.id}`);

    const subscription = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: sub.id },
    });

    if (!subscription) {
      this.logger.error(`No local subscription found for Stripe subscription ${sub.id}`);
      return;
    }

    // Idempotency: nếu đã CANCELLED thì không tạo duplicate SubscriptionEvent
    if (subscription.status === SubscriptionStatus.CANCELLED) {
      this.logger.log(`Subscription ${subscription.id} already CANCELLED – skipping`);
      return;
    }

    await this.prisma.$transaction([
      this.prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: SubscriptionStatus.CANCELLED,
          cancelledAt: new Date(),
          subscriptionCreditsRemaining: 0,
        },
      }),
      this.prisma.subscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: SubscriptionEventType.CANCELLED,
          metadata: { stripeSubscriptionId: sub.id },
        },
      }),
    ]);

    this.logger.log(`Subscription ${subscription.id} cancelled`);
  }
}
