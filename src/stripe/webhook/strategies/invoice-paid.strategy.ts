import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  CreditTransactionType,
  ReferenceType,
  SubscriptionEventType,
} from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { PricingService } from "../../../pricing/pricing.service";
import { PaymentProvider, SubscriptionStatus, InvoiceStatus, PaymentStatus } from "@prisma/client";
import { PLAN_CODES } from "../../../common/constants/plan.constants";
import { formatStripeAmountToDatabase } from "../../utils/stripe-currency.util";
import { addCalendarMonths } from "../../../common/utils/date.util";
import { json } from "stream/consumers";

@Injectable()
export class InvoicePaidStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaidStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
  ) { }

  private readonly invoicePaid = "invoice.paid";
  canHandle(eventType: string): boolean {
    return eventType === this.invoicePaid;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const stripeInvoice = event.data.object as Stripe.Invoice;
    this.logger.log(`invoice.paid: ${stripeInvoice.id}`);
    this.logger.log('Invoice details:', JSON.stringify(stripeInvoice, null, 2));
    let stripeSubscriptionId =
      typeof stripeInvoice.subscription === "string"
        ? stripeInvoice.subscription
        : stripeInvoice.subscription?.id ?? null;

    if (!stripeSubscriptionId) {
      stripeSubscriptionId = (stripeInvoice as any).parent?.subscription_details?.subscription ?? null;
    }

    if (!stripeSubscriptionId && stripeInvoice.lines?.data?.length) {
      const line = stripeInvoice.lines.data[0] as any;
      stripeSubscriptionId = line?.subscription ?? line?.parent?.subscription_item_details?.subscription ?? null;
    }

    if (!stripeSubscriptionId) {
      this.logger.log(`Invoice ${stripeInvoice.id} has no linked subscription, skipping`);
      return;
    }

    // Idempotency: kiểm tra Invoice local, có retry nhẹ nếu invoice.created đến trễ
    let invoice = await this.prisma.invoice.findFirst({
      where: { providerInvoiceId: stripeInvoice.id },
    });

    let invoiceRetries = 0;
    while (!invoice && invoiceRetries < 5) {
      this.logger.warn(`Invoice ${stripeInvoice.id} not found locally. Waiting for invoice.created...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      invoice = await this.prisma.invoice.findFirst({
        where: { providerInvoiceId: stripeInvoice.id },
      });
      invoiceRetries++;
    }

    if (!invoice) {
      this.logger.error(`No local invoice found for Stripe invoice ${stripeInvoice.id} after retries`);
      return;
    }

    if (invoice.status === InvoiceStatus.PAID) {
      this.logger.log(`Invoice ${invoice.id} already PAID – skipping`);
      return;
    }

    let subscription = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: stripeSubscriptionId },
    });
    this.logger.log(`Found subscription ${subscription} for Stripe subscription ${stripeSubscriptionId}`);
    let subRetries = 0;
    this.logger.log(`Checking for subscription ${subRetries} for Stripe subscription ${stripeSubscriptionId}`);
    while (!subscription && subRetries < 5) {
      this.logger.warn(`Subscription ${stripeSubscriptionId} not found locally. Waiting for customer.subscription.created...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      subscription = await this.prisma.subscription.findFirst({
        where: { providerSubscriptionId: stripeSubscriptionId },
      });
      subRetries++;
    }

    if (!subscription) {
      this.logger.error(`No local subscription found for Stripe subscription ${stripeSubscriptionId} after retries`);
      return;
    }

    const lineToUse = stripeInvoice.lines?.data?.find(line => line.type === 'subscription') || stripeInvoice.lines?.data?.[0];

    const price = lineToUse?.price;
    let priceId = typeof price === 'string' ? price : price?.id;

    if (!priceId) {
      priceId = (lineToUse as any)?.plan?.id;
    }

    if (!priceId) {
      priceId = (lineToUse as any)?.pricing?.price_details?.price;
    }

    if (!priceId) {
      this.logger.warn(`No price ID found in invoice lines. Falling back to subscription's current pricing option.`);
      const currentPricingOption = await this.prisma.pricingOption.findUnique({
        where: { id: subscription.pricingOptionId },
        select: { providerPriceId: true },
      });
      priceId = currentPricingOption?.providerPriceId ?? undefined;
    }

    if (!priceId) {
      this.logger.error(`No price ID in invoice ${stripeInvoice.id} lines and no fallback available`);
      return;
    }

    const pricingOption = await this.pricingService.findByProviderPriceId(priceId);
    if (!pricingOption) {
      this.logger.error(`No pricing option found for priceId ${priceId}`);
      return;
    }

    const plan = pricingOption.plan;
    const periodStart = new Date(stripeInvoice.period_start * 1000);
    const periodEnd = new Date(stripeInvoice.period_end * 1000);
    const resetMonths = Math.max(1, Math.round(plan.resetIntervalDay / 30));
    const nextCreditResetAt = addCalendarMonths(periodStart, resetMonths);

    const isInitial = stripeInvoice.billing_reason === "subscription_create";
    const eventType = isInitial ? SubscriptionEventType.CREATED : SubscriptionEventType.RENEWED;
    const description = isInitial
      ? `Credits granted – ${plan.name} (initial)`
      : `Credits granted – ${plan.name} (renewal)`;

    const paymentIntentId =
      typeof stripeInvoice.payment_intent === "string"
        ? stripeInvoice.payment_intent
        : (stripeInvoice.payment_intent as any)?.id ?? null;

    await this.prisma.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          status: InvoiceStatus.PAID,
          billingReason: stripeInvoice.billing_reason ?? null,
          paidAt: new Date(),
        },
      });

      if (paymentIntentId) {
        await tx.payment.upsert({
          where: { providerPaymentId: paymentIntentId },
          create: {
            userId: subscription.userId,
            invoiceId: invoice.id,
            provider: PaymentProvider.STRIPE,
            providerPaymentId: paymentIntentId,
            amount: formatStripeAmountToDatabase(stripeInvoice.amount_paid, stripeInvoice.currency),
            currency: stripeInvoice.currency,
            status: PaymentStatus.SUCCEEDED,
            paidAt: new Date(),
          },
          update: { status: PaymentStatus.SUCCEEDED, paidAt: new Date() },
        });
      }

      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status: SubscriptionStatus.ACTIVE, 
          pricingOptionId: pricingOption.id,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          subscriptionCreditsRemaining: plan.renewalCredits,
          nextCreditResetAt,
        },
      });

      await tx.creditTransaction.create({
        data: {
          userId: subscription.userId,
          type: CreditTransactionType.RENEWAL,
          amount: plan.renewalCredits,
          description,
          referenceType: ReferenceType.SUBSCRIPTION,
          referenceId: subscription.id,
        },
      });

      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: eventType,
          metadata: {
            stripeInvoiceId: stripeInvoice.id,
            creditsGranted: plan.renewalCredits,
            billingReason: stripeInvoice.billing_reason,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
          },
        },
      });

      this.logger.log(
        `Credits granted: subscription=${subscription.id} +${plan.renewalCredits} (${plan.name}, ${stripeInvoice.billing_reason})`,
      );
    })
  }
}
