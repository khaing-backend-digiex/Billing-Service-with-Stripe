import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  InvoiceStatus,
  SubscriptionStatus,
  CreditTransactionType,
  ReferenceType,
  SubscriptionEventType,
} from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { PricingService } from "../../../pricing/pricing.service";
import { PaymentProvider, SubscriptionStatus, InvoiceStatus, PaymentStatus } from "@prisma/client";
import { PLAN_CODES } from "../../../common/constants/plan.constants";

@Injectable()
export class InvoicePaidStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaidStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
  ) {}

  private readonly invoicePaid = "invoice.paid";
  canHandle(eventType: string): boolean {
    return eventType === this.invoicePaid;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const stripeInvoice = event.data.object as Stripe.Invoice;
    this.logger.log(`invoice.paid: ${stripeInvoice.id}`);

    const stripeSubscriptionId =
      typeof stripeInvoice.subscription === "string"
        ? stripeInvoice.subscription
        : stripeInvoice.subscription?.id ?? null;

    if (!stripeSubscriptionId) {
      this.logger.log(`Invoice ${stripeInvoice.id} has no linked subscription, skipping`);
      return;
    }

    // Idempotency: kiểm tra Invoice local
    const invoice = await this.prisma.invoice.findFirst({
      where: { providerInvoiceId: stripeInvoice.id },
    });

    if (!invoice) {
      this.logger.error(`No local invoice found for Stripe invoice ${stripeInvoice.id}`);
      return;
    }

    if (invoice.status === InvoiceStatus.PAID) {
      this.logger.log(`Invoice ${invoice.id} already PAID – skipping`);
      return;
    }

    const subscription = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: stripeSubscriptionId },
    });

    if (!subscription) {
      this.logger.error(`No local subscription found for Stripe subscription ${stripeSubscriptionId}`);
      return;
    }

    const priceId = stripeInvoice.lines.data[0]?.price?.id;
    if (!priceId) {
      this.logger.error(`No price ID in invoice ${stripeInvoice.id} lines`);
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
    const nextCreditResetAt = new Date(
      periodStart.getTime() + plan.resetIntervalDay * 86_400_000,
    );

    const isInitial = stripeInvoice.billing_reason === "subscription_create";
    const eventType = isInitial ? SubscriptionEventType.CREATED : SubscriptionEventType.RENEWED;
    const description = isInitial
      ? `Credits granted – ${plan.name} (initial)`
      : `Credits granted – ${plan.name} (renewal)`;

    await this.prisma.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: InvoiceStatus.PAID, paidAt: new Date() },
      });

      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
      const user = await this.prisma.user.findFirst({
        where: { providerCustomerId: invoice.customer as string }
      });

      if (!user) {
        this.logger.error(`User not found for customer ${invoice.customer}`);
        return;
      }

      // Upsert Subscription in DB
      let currentPeriodEnd = new Date(lineItem.period.end * 1000);
      const currentPeriodStart = new Date(lineItem.period.start * 1000);

      if (pricingOption.plan.code === PLAN_CODES.FREE) {
        currentPeriodEnd.setFullYear(currentPeriodEnd.getFullYear() + 100);
      }

      // Add resetIntervalDay from plan
      const resetIntervalDay = pricingOption.plan.resetIntervalDay;
      const nextCreditResetAt = new Date();
      nextCreditResetAt.setDate(nextCreditResetAt.getDate() + resetIntervalDay);

      const dbSubscription = await this.prisma.subscription.upsert({
        where: { userId: user.id },
        update: {
          pricingOptionId: pricingOption.id,
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

      // Handle Invoice
      const amountPaid = invoice.amount_paid / 100;
      const paidAt = invoice.status_transitions?.paid_at 
        ? new Date(invoice.status_transitions.paid_at * 1000) 
        : new Date();
      const dueAt = new Date(invoice.created * 1000);

      let dbInvoice = await this.prisma.invoice.findFirst({
        where: { providerInvoiceId: invoice.id }
      });

      if (!dbInvoice) {
        dbInvoice = await this.prisma.invoice.create({
          data: {
            subscriptionId: dbSubscription.id,
            provider: PaymentProvider.STRIPE,
            providerInvoiceId: invoice.id,
            amount: amountPaid,
            currency: invoice.currency,
            status: InvoiceStatus.PAID,
            dueAt,
            paidAt,
          }
        });
      } else {
        dbInvoice = await this.prisma.invoice.update({
          where: { id: dbInvoice.id },
          data: {
            status: InvoiceStatus.PAID,
            paidAt,
          }
        });
      }

      // Handle Payment
      const paymentIntentId = invoice.payment_intent as string | null;
      if (paymentIntentId && amountPaid > 0) {
        await this.prisma.payment.upsert({
          where: { providerPaymentId: paymentIntentId },
          update: {
            status: PaymentStatus.SUCCEEDED,
            paidAt,
          },
          create: {
            userId: user.id,
            invoiceId: dbInvoice.id,
            provider: PaymentProvider.STRIPE,
            providerPaymentId: paymentIntentId,
            amount: amountPaid,
            currency: invoice.currency,
            status: PaymentStatus.SUCCEEDED,
            paidAt,
          }
        });
      }
    });

    this.logger.log(
      `Credits granted: subscription=${subscription.id} +${plan.renewalCredits} (${plan.name}, ${stripeInvoice.billing_reason})`,
    );
  }
}
