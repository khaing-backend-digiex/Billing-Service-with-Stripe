import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { SubscriptionSyncService } from "../../sync/subscription-sync.service";

@Injectable()
export class CustomerSubscriptionCreatedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(
    CustomerSubscriptionCreatedStrategy.name,
  );

  constructor(private readonly subscriptionSync: SubscriptionSyncService) {}

  private readonly customerSubscriptionCreated =
    "customer.subscription.created";
  canHandle(eventType: string): boolean {
    return eventType === this.customerSubscriptionCreated;
  }


  async handle(event: Stripe.Event): Promise<void> {
    const sub = event.data.object as Stripe.Subscription;
    this.logger.log(`customer.subscription.created: ${sub.id}`);
    await this.subscriptionSync.syncFromStripe(sub);
  }
}
