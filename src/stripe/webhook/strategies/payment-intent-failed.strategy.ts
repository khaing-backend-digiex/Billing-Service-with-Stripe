import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PaymentRecordService } from "../../payment-record.service";
import {
  STRIPE_METADATA_KEY,
  STRIPE_WEBHOOK_EVENT,
} from "../../../common/constants/stripe.constants";


@Injectable()
export class PaymentIntentFailedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(PaymentIntentFailedStrategy.name);

  constructor(private readonly paymentService: PaymentRecordService) {}

  canHandle(eventType: string): boolean {
    return eventType === STRIPE_WEBHOOK_EVENT.PAYMENT_INTENT_PAYMENT_FAILED;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    this.logger.warn(
      `payment_intent.payment_failed: ${paymentIntent.id} – ${paymentIntent.last_payment_error?.message ?? "unknown error"}`,
    );

    
    const existing = await this.paymentService.markFailed(paymentIntent.id);
    if (existing) return;

    const addonPackageId = paymentIntent.metadata?.[STRIPE_METADATA_KEY.ADDON_PACKAGE_ID];
    const userIdStr = paymentIntent.metadata?.[STRIPE_METADATA_KEY.USER_ID];

    
    if (!addonPackageId || !userIdStr) {
      this.logger.log(`Intent ${paymentIntent.id} is not an addon purchase – skipping`);
      return;
    }

    const userId = userIdStr;

    
    await this.paymentService.recordFailed({
      userId,
      providerPaymentId: paymentIntent.id,
      providerAmount: paymentIntent.amount,
      currency: paymentIntent.currency,
      addonPackageId,
    });

    this.logger.log(
      `Recorded FAILED addon payment for user ${userId} (intent ${paymentIntent.id})`,
    );
  }
}
