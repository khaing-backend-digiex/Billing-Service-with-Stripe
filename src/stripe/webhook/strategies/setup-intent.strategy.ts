import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PaymentMethodSyncService } from "../../sync/payment-method-sync.service";
import { StripeService } from "../../stripe.service";
import { STRIPE_WEBHOOK_EVENT } from "../../../common/constants/stripe.constants";

@Injectable()
export class SetupIntentStrategy implements WebhookStrategy {
  private readonly logger = new Logger(SetupIntentStrategy.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly paymentMethodSync: PaymentMethodSyncService,
  ) {}

  canHandle(eventType: string): boolean {
    return (
      eventType === STRIPE_WEBHOOK_EVENT.SETUP_INTENT_SUCCEEDED ||
      eventType === STRIPE_WEBHOOK_EVENT.SETUP_INTENT_SETUP_FAILED
    );
  }

  async handle(event: Stripe.Event): Promise<void> {
    const setupIntent = event.data.object as Stripe.SetupIntent;

    if (event.type === STRIPE_WEBHOOK_EVENT.SETUP_INTENT_SETUP_FAILED) {
      this.logger.warn(
        `setup_intent.setup_failed: ${setupIntent.id} – ${setupIntent.last_setup_error?.message ?? "unknown error"}`,
      );
      return;
    }

    this.logger.log(`setup_intent.succeeded: ${setupIntent.id}`);

    const paymentMethodId =
      typeof setupIntent.payment_method === "string"
        ? setupIntent.payment_method
        : setupIntent.payment_method?.id;

    const customerId =
      typeof setupIntent.customer === "string"
        ? setupIntent.customer
        : setupIntent.customer?.id;

    if (!paymentMethodId || !customerId) {
      this.logger.error(
        `Setup intent ${setupIntent.id} has no payment method or customer – skipping`,
      );
      return;
    }

    const details = await this.stripeService.getPaymentMethod(paymentMethodId);
    if (!details) {
      this.logger.error(`Payment method ${paymentMethodId} not found on Stripe – skipping`);
      return;
    }

    await this.paymentMethodSync.syncAttached({ ...details, customerId });
    await this.setAsDefaultIfFirst(customerId, paymentMethodId);
  }
  
  private async setAsDefaultIfFirst(
    customerId: string,
    paymentMethodId: string,
  ): Promise<void> {
    const currentDefault = await this.stripeService.getDefaultPaymentMethodId(customerId);
    if (currentDefault) return;

    await this.stripeService.setDefaultPaymentMethod(customerId, paymentMethodId);
    await this.paymentMethodSync.syncDefaultByCustomer(customerId);

    this.logger.log(`Payment method ${paymentMethodId} set as default (first card)`);
  }
}
