import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PaymentMethodSyncService } from "../../sync/payment-method-sync.service";
import { StripeService } from "../../stripe.service";
import { STRIPE_WEBHOOK_EVENT } from "../../../common/constants/stripe.constants";

@Injectable()
export class PaymentMethodStrategy implements WebhookStrategy {
  private readonly logger = new Logger(PaymentMethodStrategy.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly paymentMethodSync: PaymentMethodSyncService,
  ) {}

  canHandle(eventType: string): boolean {
    return (
      eventType === STRIPE_WEBHOOK_EVENT.PAYMENT_METHOD_ATTACHED ||
      eventType === STRIPE_WEBHOOK_EVENT.PAYMENT_METHOD_UPDATED ||
      eventType === STRIPE_WEBHOOK_EVENT.PAYMENT_METHOD_DETACHED
    );
  }

  async handle(event: Stripe.Event): Promise<void> {
    const details = this.stripeService.mapRawPaymentMethod(event.data.object);
    this.logger.log(`${event.type}: ${details.id}`);

    if (event.type === STRIPE_WEBHOOK_EVENT.PAYMENT_METHOD_DETACHED) {
      await this.paymentMethodSync.syncDetached(details.id);
      return;
    }

    await this.paymentMethodSync.syncAttached(details);
  }
}
