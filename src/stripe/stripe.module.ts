import { Module, forwardRef } from "@nestjs/common";
import { StripeController } from "./stripe.controller";
import { StripeService } from "./stripe.service";
import { StripeWebhookController } from "./webhook/stripe-webhook.controller";
import { StripeWebhookService } from "./webhook/stripe-webhook.service";
import { UsersModule } from "../users/users.module";
import { PricingModule } from "../pricing/pricing.module";
import { CheckoutSessionCompletedStrategy } from "./webhook/strategies/checkout-session-completed.strategy";
import { InvoicePaidStrategy } from "./webhook/strategies/invoice-paid.strategy";
import { InvoicePaymentFailedStrategy } from "./webhook/strategies/invoice-payment-failed.strategy";
import { SubscriptionDeletedStrategy } from "./webhook/strategies/subscription-deleted.strategy";
import { WebhookStrategyFactory } from "./webhook/strategies/webhook-strategy.factory";

@Module({
  imports: [forwardRef(() => UsersModule), PricingModule],
  controllers: [StripeController, StripeWebhookController],
  providers: [
    StripeService, 
    StripeWebhookService,
    CheckoutSessionCompletedStrategy,
    InvoicePaidStrategy,
    InvoicePaymentFailedStrategy,
    SubscriptionDeletedStrategy,
    WebhookStrategyFactory,
    {
      provide: "WEBHOOK_STRATEGIES",
      useFactory: (
        checkoutStrategy: CheckoutSessionCompletedStrategy,
        invoiceStrategy: InvoicePaidStrategy,
        invoiceFailedStrategy: InvoicePaymentFailedStrategy,
        subscriptionStrategy: SubscriptionDeletedStrategy,
      ) => [checkoutStrategy, invoiceStrategy, invoiceFailedStrategy, subscriptionStrategy],
      inject: [
        CheckoutSessionCompletedStrategy,
        InvoicePaidStrategy,
        InvoicePaymentFailedStrategy,
        SubscriptionDeletedStrategy,
      ],
    },
  ],
  exports: [StripeService],
})
export class StripeModule {}
