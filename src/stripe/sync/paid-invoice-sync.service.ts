import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  CreditTransactionType,
  ReferenceType,
  SubscriptionEventType,
  PaymentProvider,
  SubscriptionStatus,
  InvoiceStatus,
  PaymentStatus,
} from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { PricingService } from "../../pricing/pricing.service";
import { formatStripeAmountToDatabase } from "../utils/stripe-currency.util";
import { addCalendarMonths } from "../../common/utils/date.util";
import { PaymentInvoice } from "../../payments/types/payment.types";


@Injectable()
export class PaidInvoiceSyncService {
  private readonly logger = new Logger(PaidInvoiceSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
  ) {}

  async applyPaidInvoice(
    stripeInvoice: PaymentInvoice,
    stripeSubscriptionId: string,
  ): Promise<void> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: stripeSubscriptionId },
    });

    if (!subscription) {
      throw new Error(
        `No local subscription for Stripe subscription ${stripeSubscriptionId} yet – invoice ${stripeInvoice.id} will be retried`,
      );
    }

   
    const invoice = await this.prisma.invoice.upsert({
      where: { providerInvoiceId: stripeInvoice.id },
      update: {},
      create: {
        subscriptionId: subscription.id,
        provider: PaymentProvider.STRIPE,
        providerInvoiceId: stripeInvoice.id,
        amount: formatStripeAmountToDatabase(stripeInvoice.amountDue, stripeInvoice.currency),
        currency: stripeInvoice.currency,
        billingReason: stripeInvoice.billingReason ?? null,
        status: InvoiceStatus.OPEN,
        dueAt: stripeInvoice.dueDate
          ? new Date(stripeInvoice.dueDate * 1000)
          : new Date(stripeInvoice.periodEnd * 1000),
      },
    });

    if (invoice.status === InvoiceStatus.PAID) {
      this.logger.log(`Invoice ${invoice.id} already PAID – skipping`);
      return;
    }

    const lineToUse =
      stripeInvoice.lines?.find((line) => line.type === "subscription") ??
      stripeInvoice.lines?.[0];

 
    // Line price là nguồn chính; line lạ (proration…) thiếu price → dùng pricing
    // option hiện tại của subscription để không bỏ lỡ lần cấp credit.
    let priceId = lineToUse?.priceId;
    if (!priceId) {
      const current = await this.prisma.pricingOption.findUnique({
        where: { id: subscription.pricingOptionId },
        select: { providerPriceId: true },
      });
      priceId = current?.providerPriceId ?? undefined;
    }

    if (!priceId) {
      this.logger.error(`No price ID for invoice ${stripeInvoice.id} and no fallback available`);
      return;
    }

    const pricingOption = await this.pricingService.findByProviderPriceId(priceId);
    if (!pricingOption) {
      this.logger.error(`No pricing option found for priceId ${priceId}`);
      return;
    }

    const plan = pricingOption.plan;
    const periodStart = new Date(stripeInvoice.periodStart * 1000);
    const periodEnd = new Date(stripeInvoice.periodEnd * 1000);
    const resetMonths = Math.max(1, Math.round(plan.resetIntervalDay / 30));
    const nextCreditResetAt = addCalendarMonths(periodStart, resetMonths);

    const isInitial = stripeInvoice.billingReason === "subscription_create";
    const eventType = isInitial ? SubscriptionEventType.CREATED : SubscriptionEventType.RENEWED;
    const description = isInitial
      ? `Credits granted – ${plan.name} (initial)`
      : `Credits granted – ${plan.name} (renewal)`;

    const paymentIntentId = stripeInvoice.paymentIntentId ?? null;

    await this.prisma.$transaction(async (tx) => {
      
      const claimed = await tx.invoice.updateMany({
        where: { id: invoice.id, status: { not: InvoiceStatus.PAID } },
        data: {
          status: InvoiceStatus.PAID,
          billingReason: stripeInvoice.billingReason ?? null,
          paidAt: new Date(),
        },
      });

      if (claimed.count === 0) {
        this.logger.log(`Invoice ${invoice.id} already PAID (concurrent delivery) – skipping`);
        return;
      }

      if (paymentIntentId) {
        await tx.payment.upsert({
          where: { providerPaymentId: paymentIntentId },
          create: {
            userId: subscription.userId,
            invoiceId: invoice.id,
            provider: PaymentProvider.STRIPE,
            providerPaymentId: paymentIntentId,
          amount: formatStripeAmountToDatabase(stripeInvoice.amountPaid, stripeInvoice.currency),
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
      this.logger.log(
        `Subscription ${subscription.id} updated: status=ACTIVE, currentPeriodStart=${periodStart.toISOString()}, currentPeriodEnd=${periodEnd.toISOString()}, subscriptionCreditsRemaining=${plan.renewalCredits}, nextCreditResetAt=${nextCreditResetAt.toISOString()}`,
      );

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
            billingReason: stripeInvoice.billingReason,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
          },
        },
      });

      this.logger.log(
        `Credits granted: subscription=${subscription.id} +${plan.renewalCredits} (${plan.name}, ${stripeInvoice.billingReason})`,
      );
    });
  }
}
