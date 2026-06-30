import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { SubscriptionStatus } from "@prisma/client";

@Injectable()
export class SubscriptionDeletedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(SubscriptionDeletedStrategy.name);

  constructor(private readonly prisma: PrismaService) {}

  canHandle(eventType: string): boolean {
    return eventType === "customer.subscription.deleted";
  }

  async handle(event: Stripe.Event): Promise<void> {
    const subscription = event.data.object as Stripe.Subscription;
    this.logger.log(`Subscription canceled: ${subscription.id}`);
    
    await this.prisma.subscription.updateMany({
      where: { providerSubscriptionId: subscription.id },
      data: {
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: new Date(),
      }
    });
  }
}
