import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { StripeService } from "../stripe.service";
import { PaymentStatus } from "../../database/entities/payment.entity";

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(private readonly stripeService: StripeService) {}

  async handleEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case "checkout.session.completed":
        await this.handleCheckoutSessionCompleted(
          event.data.object as Stripe.Checkout.Session,
        );
        break;

      case "payment_intent.succeeded":
        await this.handlePaymentIntentSucceeded(
          event.data.object as Stripe.PaymentIntent,
        );
        break;

      case "payment_intent.payment_failed":
        await this.handlePaymentIntentFailed(
          event.data.object as Stripe.PaymentIntent,
        );
        break;

      case "customer.subscription.created":
        await this.handleSubscriptionCreated(
          event.data.object as Stripe.Subscription,
        );
        break;

      case "customer.subscription.updated":
        await this.handleSubscriptionUpdated(
          event.data.object as Stripe.Subscription,
        );
        break;

      case "customer.subscription.deleted":
        await this.handleSubscriptionDeleted(
          event.data.object as Stripe.Subscription,
        );
        break;

      case "invoice.paid":
        await this.handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;

      case "invoice.payment_failed":
        await this.handleInvoicePaymentFailed(
          event.data.object as Stripe.Invoice,
        );
        break;

      default:
        this.logger.log(`⚡ Unhandled event type: ${event.type}`);
    }
  }

  private async handleCheckoutSessionCompleted(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    this.logger.log(`💰 Checkout session completed: ${session.id}`);

    const userId = session.metadata?.userId
      ? parseInt(session.metadata.userId, 10)
      : null;

    if (userId) {
      await this.stripeService.saveCheckoutPayment(
        session.id,
        userId,
        session.amount_total || 0,
        session.currency || "usd",
        PaymentStatus.SUCCEEDED,
      );
    }
  }

  private async handlePaymentIntentSucceeded(
    paymentIntent: Stripe.PaymentIntent,
  ): Promise<void> {
    this.logger.log(`✅ Payment succeeded: ${paymentIntent.id}`);

    await this.stripeService.updatePaymentStatus(
      paymentIntent.id,
      PaymentStatus.SUCCEEDED,
    );
  }

  private async handlePaymentIntentFailed(
    paymentIntent: Stripe.PaymentIntent,
  ): Promise<void> {
    this.logger.log(`❌ Payment failed: ${paymentIntent.id}`);

    await this.stripeService.updatePaymentStatus(
      paymentIntent.id,
      PaymentStatus.FAILED,
    );
  }

  private async handleSubscriptionCreated(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    this.logger.log(`🆕 Subscription created: ${subscription.id}`);
  }

  private async handleSubscriptionUpdated(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    this.logger.log(
      `🔄 Subscription updated: ${subscription.id} → ${subscription.status}`,
    );
  }

  private async handleSubscriptionDeleted(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    this.logger.log(`🗑️  Subscription canceled: ${subscription.id}`);
  }

  private async handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    this.logger.log(`📧 Invoice paid: ${invoice.id}`);
  }

  private async handleInvoicePaymentFailed(
    invoice: Stripe.Invoice,
  ): Promise<void> {
    this.logger.log(`⚠️  Invoice payment failed: ${invoice.id}`);
  }
}
