import Stripe from "stripe";

export interface WebhookStrategy {
  canHandle(eventType: string): boolean;
  handle(event: Stripe.Event): Promise<void>;
}
