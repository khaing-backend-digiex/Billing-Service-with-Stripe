
import { Injectable, Logger } from "@nestjs/common";
import {
  CreditGrantSourceType,
  InvoiceStatus,
  SubscriptionEventType,
  SubscriptionStatus,
} from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { PricingService } from "../../pricing/pricing.service";
import { InvoiceRecordService } from "../invoice-record.service";
import { PaymentRecordService } from "../payment-record.service";
import { PaymentInvoice } from "../../payments/types/payment.types";
import { addCalendarMonths, fromUnixSeconds } from "../../common/utils/date.util";
import {
  STRIPE_BILLING_REASON,
  STRIPE_INVOICE_LINE_TYPE,
} from "../../common/constants/stripe.constants";
import { CreditService } from "../../credits/credit.service";
import { creditKey } from "../../credits/credit.types";
import { resolveResetMonths } from "../../credits/credit-policy.util";

@Injectable()
export class PaidInvoiceSyncService {
  private readonly logger = new Logger(PaidInvoiceSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
    private readonly invoiceService: InvoiceRecordService,
    private readonly paymentService: PaymentRecordService,
    private readonly creditService: CreditService,
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

    const invoice = await this.invoiceService.ensureLocal(
      paidInvoice,
      subscription.id,
    );

    if (invoice.status === InvoiceStatus.PAID) {
      this.logger.log(`Invoice ${invoice.id} already PAID – skipping`);
      return;
    }

    const lineToUse =
      paidInvoice.lines.find(
        (line) =>
          line.type === STRIPE_INVOICE_LINE_TYPE.SUBSCRIPTION && !line.isProration,
      ) ??
      paidInvoice.lines.find((line) => !line.isProration && line.subscriptionId) ??
      paidInvoice.lines.find(
        (line) => line.type === STRIPE_INVOICE_LINE_TYPE.SUBSCRIPTION,
      ) ??
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
    const periodStart = fromUnixSeconds(lineToUse?.periodStart ?? paidInvoice.periodStart);
    const periodEnd = fromUnixSeconds(lineToUse?.periodEnd ?? paidInvoice.periodEnd);
    const resetMonths = resolveResetMonths(plan.creditPolicy);
    const nextCreditResetAt = addCalendarMonths(periodStart, resetMonths);

    const stripeSubscriptionId =
      paidInvoice.subscriptionId ?? lineToUse?.subscriptionId ?? null;
    const isStale = periodStart < subscription.currentPeriodStart;
    const shouldRepoint =
      stripeSubscriptionId !== null &&
      stripeSubscriptionId !== subscription.providerSubscriptionId &&
      !isStale;

    if (stripeSubscriptionId !== null && !shouldRepoint && isStale) {
      this.logger.warn(
        `Invoice ${paidInvoice.id} belongs to an older period – keeping providerSubscriptionId ${subscription.providerSubscriptionId}`,
      );
    }

    const isInitial =
      paidInvoice.billingReason === STRIPE_BILLING_REASON.SUBSCRIPTION_CREATE;
    const isCycleChange =
      paidInvoice.billingReason === STRIPE_BILLING_REASON.SUBSCRIPTION_UPDATE;
    const eventType = isInitial
      ? SubscriptionEventType.CREATED
      : SubscriptionEventType.RENEWED;
    const description = isInitial
      ? `Credits granted – ${plan.name} (initial)`
      : isCycleChange
        ? `Credits granted – ${plan.name} (upgrade)`
        : `Credits granted – ${plan.name} (renewal)`;
    const providerPaymentId = paidInvoice.paymentIntentId ?? paidInvoice.id;
  
    const paidAt = paidInvoice.paidAt ? fromUnixSeconds(paidInvoice.paidAt) : new Date();
    await this.prisma.$transaction(async (tx) => {
      const claimed = await this.invoiceService.claimAsPaid(
        tx,
        invoice.id,
        paidInvoice.billingReason ?? null,
        paidAt,
      );

      if (!claimed) {
        this.logger.log(
          `Invoice ${invoice.id} already PAID (concurrent delivery) – skipping`,
        );
        return;
      }

      if (paidInvoice.amountPaid > 0) {
        await this.paymentService.recordSucceeded(
          {
            userId: subscription.userId,
            providerPaymentId,
            providerAmount: paidInvoice.amountPaid,
            currency: paidInvoice.currency,
            invoiceId: invoice.id,
            paidAt,
          },
          tx,
        );
      }

      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status: SubscriptionStatus.ACTIVE,
          pricingOptionId: pricingOption.id,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          nextCreditResetAt,
          ...(shouldRepoint
            ? { providerSubscriptionId: stripeSubscriptionId }
            : {}),
        },
      });

      if (shouldRepoint) {
        this.logger.log(
          `Subscription ${subscription.id} repointed: ${subscription.providerSubscriptionId} → ${stripeSubscriptionId}`,
        );
      }

      const fallbackSubs = await tx.subscription.findMany({
        where: {
          userId: subscription.userId,
          productId: plan.productId,
          id: { not: subscription.id },
          status: SubscriptionStatus.ACTIVE,
        }
      });
      for (const fallback of fallbackSubs) {
        await tx.subscription.update({ where: { id: fallback.id }, data: { status: SubscriptionStatus.EXPIRED }});
        await this.creditService.revokeSubscriptionCredits({
          userId: subscription.userId,
          productId: plan.productId,
          description: `Fallback free plan expired upon Pro recovery`,
          subscriptionId: fallback.id,
          idempotencyKey: creditKey.invoiceFallbackRevoke(fallback.id, invoice.id),
        }, tx);
        this.logger.log(`Expired fallback Free subscription ${fallback.id} upon Pro recovery`);
      }
      this.logger.log(
        `Subscription ${subscription.id} updated: status=ACTIVE, currentPeriodStart=${periodStart.toISOString()}, currentPeriodEnd=${periodEnd.toISOString()}, nextCreditResetAt=${nextCreditResetAt.toISOString()}`,
      );

      const creditsGranted = plan.creditPolicy?.creditAmount ?? 0;

      await this.creditService.revokeSubscriptionCredits(
        {
          userId: subscription.userId,
          productId: plan.productId,
          description: `Unused credits expired before renewal/upgrade`,
          subscriptionId: subscription.id,
          invoiceId: invoice.id,
          idempotencyKey: creditKey.invoiceSubscriptionRevoke(invoice.id),
        },
        tx,
      );

      await this.creditService.grantSubscriptionAllowance(
        {
          userId: subscription.userId,
          productId: plan.productId,
          amount: creditsGranted,
          description,
          subscriptionId: subscription.id,
          invoiceId: invoice.id,
          sourceType: CreditGrantSourceType.SUBSCRIPTION_ALLOCATION,
          idempotencyKey: creditKey.invoiceSubscriptionGrant(invoice.id),
          expiresAt: nextCreditResetAt,
        },
        tx,
      );

      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: isCycleChange ? SubscriptionEventType.UPGRADED : eventType,
          metadata: {
            stripeInvoiceId: paidInvoice.id,
            creditsGranted,
            billingReason: paidInvoice.billingReason ?? null,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
          },
        },
      });

      this.logger.log(
        `Credits granted: subscription=${subscription.id} +${creditsGranted} (${plan.name}, ${paidInvoice.billingReason})`,
      );
    });
  }
}
