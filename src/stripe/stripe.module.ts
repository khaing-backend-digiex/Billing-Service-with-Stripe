import { Module, forwardRef } from "@nestjs/common";
import { StripeController } from "./stripe.controller";
import { StripeService } from "./stripe.service";
import { StripeWebhookController } from "./webhook/stripe-webhook.controller";
import { StripeWebhookService } from "./webhook/stripe-webhook.service";
import { UsersModule } from "../users/users.module";
import { PricingModule } from "../pricing/pricing.module";
import { CheckoutSessionCompletedStrategy } from "./webhook/strategies/checkout-session-completed.strategy";
import { InvoiceCreatedStrategy } from "./webhook/strategies/invoice.created";
import { InvoicePaidStrategy } from "./webhook/strategies/invoice-paid.strategy";
import { InvoicePaymentFailedStrategy } from "./webhook/strategies/invoice.payment_failed";
import { CustomerSubscriptionCreatedStrategy } from "./webhook/strategies/customer.subscription.created";
import { CustomerSubscriptionUpdatedStrategy } from "./webhook/strategies/customer.subscription.updated";
import { CustomerSubscriptionDeletedStrategy } from "./webhook/strategies/customer.subscription.deleted";
import { WebhookStrategyFactory } from "./webhook/strategies/webhook-strategy.factory";

@Module({
  imports: [forwardRef(() => UsersModule), PricingModule],
  controllers: [StripeController, StripeWebhookController],
  providers: [
    StripeService,
    StripeWebhookService,
    CheckoutSessionCompletedStrategy,
    InvoiceCreatedStrategy,
    InvoicePaidStrategy,
    InvoicePaymentFailedStrategy,
    CustomerSubscriptionCreatedStrategy,
    CustomerSubscriptionUpdatedStrategy,
    CustomerSubscriptionDeletedStrategy,
    WebhookStrategyFactory,
    {
      provide: "WEBHOOK_STRATEGIES",
      useFactory: (
        checkoutSessionCompletedStrategy: CheckoutSessionCompletedStrategy,
        invoiceCreatedStrategy: InvoiceCreatedStrategy,
        invoicePaidStrategy: InvoicePaidStrategy,
        invoicePaymentFailedStrategy: InvoicePaymentFailedStrategy,
        customerSubscriptionCreatedStrategy: CustomerSubscriptionCreatedStrategy,
        customerSubscriptionUpdatedStrategy: CustomerSubscriptionUpdatedStrategy,
        customerSubscriptionDeletedStrategy: CustomerSubscriptionDeletedStrategy,
      ) => [
        checkoutSessionCompletedStrategy,
        invoiceCreatedStrategy,
        invoicePaidStrategy,
        invoicePaymentFailedStrategy,
        customerSubscriptionCreatedStrategy,
        customerSubscriptionUpdatedStrategy,
        customerSubscriptionDeletedStrategy,
      ],
      inject: [
        CheckoutSessionCompletedStrategy,
        InvoiceCreatedStrategy,
        InvoicePaidStrategy,
        InvoicePaymentFailedStrategy,
        CustomerSubscriptionCreatedStrategy,
        CustomerSubscriptionUpdatedStrategy,
        CustomerSubscriptionDeletedStrategy,
      ],
    },
  ],
  exports: [StripeService],
})
export class StripeModule {}
