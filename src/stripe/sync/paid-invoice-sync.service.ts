import { Injectable, Logger } from "@nestjs/common";
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
import { PaymentInvoice } from "../../payments/types/payment.types";
import { formatStripeAmountToDatabase } from "../utils/stripe-currency.util";
import { addCalendarMonths } from "../../common/utils/date.util";
import { PLAN_CODES } from "../../common/constants/plan.constants";

@Injectable()
export class PaidInvoiceSyncService {
  private readonly logger = new Logger(PaidInvoiceSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
  ) {}

  async applyPaidInvoice(
    paidInvoice: PaymentInvoice,
    subscriptionId: string,
  ): Promise<void> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
    });

    if (!subscription) {
      throw new Error(
        `No local subscription ${subscriptionId} for invoice ${paidInvoice.id}`,
      );
    }

    const invoice = await this.prisma.invoice.upsert({
      where: { providerInvoiceId: paidInvoice.id },
      update: {},
      create: {
        subscriptionId: subscription.id,
        provider: PaymentProvider.STRIPE,
        providerInvoiceId: paidInvoice.id,
        amount: formatStripeAmountToDatabase(
          paidInvoice.amountDue,
          paidInvoice.currency,
        ),
        currency: paidInvoice.currency,
        billingReason: paidInvoice.billingReason ?? null,
        status: InvoiceStatus.OPEN,
        dueAt: paidInvoice.dueDate
          ? new Date(paidInvoice.dueDate * 1000)
          : new Date(paidInvoice.periodEnd * 1000),
      },
    });

    if (invoice.status === InvoiceStatus.PAID) {
      this.logger.log(`Invoice ${invoice.id} already PAID – skipping`);
      return;
    }

    const lineToUse =
      paidInvoice.lines.find((line) => line.type === "subscription" && !line.isProration) ??
      paidInvoice.lines.find((line) => !line.isProration && line.subscriptionId) ??
      paidInvoice.lines.find((line) => line.type === "subscription") ??
      paidInvoice.lines[0];

    let priceId: string | undefined = lineToUse?.priceId ?? undefined;
    if (!priceId) {
      const current = await this.prisma.pricingOption.findUnique({
        where: { id: subscription.pricingOptionId },
        select: { providerPriceId: true },
      });
      priceId = current?.providerPriceId ?? undefined;
    }

    if (!priceId) {
      this.logger.error(
        `No price ID for invoice ${paidInvoice.id} and no fallback available`,
      );
      return;
    }

    const pricingOption =
      await this.pricingService.findByProviderPriceId(priceId);
    if (!pricingOption) {
      this.logger.error(`No pricing option found for priceId ${priceId}`);
      return;
    }

    const plan = pricingOption.plan;
    const periodStart = new Date(paidInvoice.periodStart * 1000);
    const periodEnd = new Date(paidInvoice.periodEnd * 1000);
    const resetMonths = Math.max(1, Math.round(plan.resetIntervalDay / 30));
    const nextCreditResetAt = addCalendarMonths(periodStart, resetMonths);

    const isInitial = paidInvoice.billingReason === "subscription_create";
    const eventType = isInitial
      ? SubscriptionEventType.CREATED
      : SubscriptionEventType.RENEWED;
    const description = isInitial
      ? `Credits granted – ${plan.name} (initial)`
      : `Credits granted – ${plan.name} (renewal)`;

    const paymentIntentId = paidInvoice.paymentIntentId ?? null;

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.invoice.updateMany({
        where: { id: invoice.id, status: { not: InvoiceStatus.PAID } },
        data: {
          status: InvoiceStatus.PAID,
          billingReason: paidInvoice.billingReason ?? null,
          paidAt: new Date(),
        },
      });

      if (claimed.count === 0) {
        this.logger.log(
          `Invoice ${invoice.id} already PAID (concurrent delivery) – skipping`,
        );
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
            amount: formatStripeAmountToDatabase(
              paidInvoice.amountPaid,
              paidInvoice.currency,
            ),
            currency: paidInvoice.currency,
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

      const walletUpdate = await tx.creditWallet.updateMany({
        where: { userId: subscription.userId },
        data: { is_active: plan.code !== PLAN_CODES.FREE },
      });

      if (walletUpdate.count === 0) {
        this.logger.log(
          `No credit wallet found for user ${subscription.userId}, skipping wallet update`,
        );
      }

      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: eventType,
          metadata: {
            stripeInvoiceId: paidInvoice.id,
            creditsGranted: plan.renewalCredits,
            billingReason: paidInvoice.billingReason ?? null,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
          },
        },
      });

      this.logger.log(
        `Credits granted: subscription=${subscription.id} +${plan.renewalCredits} (${plan.name}, ${paidInvoice.billingReason})`,
      );
    });
  }
}
