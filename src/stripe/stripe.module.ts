import { Module } from "@nestjs/common";
import { StripeService } from "./stripe.service";
import { StripeController } from "./stripe.controller";
import { StripeWebhookController } from "./webhook/stripe-webhook.controller";
import { StripeWebhookService } from "./webhook/stripe-webhook.service";
import { UsersModule } from "../users/users.module";
import { PricingModule } from "../pricing/pricing.module";
import { InvoicePaidStrategy } from "./webhook/strategies/invoice-paid.strategy";
import { InvoicePaymentFailedStrategy } from "./webhook/strategies/invoice.payment_failed";
import { PaymentIntentSucceededStrategy } from "./webhook/strategies/payment-intent-succeeded.strategy";
import { CustomerSubscriptionUpdatedStrategy } from "./webhook/strategies/customer.subscription.updated";
import { CustomerSubscriptionDeletedStrategy } from "./webhook/strategies/customer.subscription.deleted";
import { WebhookStrategyFactory } from "./webhook/strategies/webhook-strategy.factory";
import { FreePlanDowngradeService } from "./webhook/free-plan-downgrade.service";
import { SubscriptionSyncService } from "./sync/subscription-sync.service";
import { PaidInvoiceSyncService } from "./sync/paid-invoice-sync.service";
import { CreditsModule } from "../credits/credits.module";


@Module({
  imports: [UsersModule, PricingModule, CreditsModule],
  controllers: [StripeController, StripeWebhookController],
  providers: [

    StripeService,
    StripeWebhookService,
    FreePlanDowngradeService,
    SubscriptionSyncService,
    PaidInvoiceSyncService,
    InvoicePaidStrategy,
    InvoicePaymentFailedStrategy,
    PaymentIntentSucceededStrategy,
    CustomerSubscriptionUpdatedStrategy,
    CustomerSubscriptionDeletedStrategy,
    WebhookStrategyFactory,
    {
      provide: "WEBHOOK_STRATEGIES",
      useFactory: (
        invoicePaidStrategy: InvoicePaidStrategy,
        invoicePaymentFailedStrategy: InvoicePaymentFailedStrategy,
        paymentIntentSucceededStrategy: PaymentIntentSucceededStrategy,
        customerSubscriptionUpdatedStrategy: CustomerSubscriptionUpdatedStrategy,
        customerSubscriptionDeletedStrategy: CustomerSubscriptionDeletedStrategy,
      ) => [
        invoicePaidStrategy,
        invoicePaymentFailedStrategy,
        paymentIntentSucceededStrategy,
        customerSubscriptionUpdatedStrategy,
        customerSubscriptionDeletedStrategy,
      ],
      inject: [
        InvoicePaidStrategy,
        InvoicePaymentFailedStrategy,
        PaymentIntentSucceededStrategy,
        CustomerSubscriptionUpdatedStrategy,
        CustomerSubscriptionDeletedStrategy,
      ],
    },
  ],
  exports: [StripeService, SubscriptionSyncService, PaidInvoiceSyncService],
})
export class StripeModule { }
