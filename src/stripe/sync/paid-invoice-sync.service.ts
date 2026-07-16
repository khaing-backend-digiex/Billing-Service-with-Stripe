
import { Injectable, Logger } from "@nestjs/common";
import {
  InvoiceStatus,
  SubscriptionEventType,
  SubscriptionStatus,
} from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { PricingService } from "../../pricing/pricing.service";
import { InvoiceRecordService } from "../invoice-record.service";
import { PaymentRecordService } from "../payment-record.service";
import { PaymentInvoice } from "../../payments/types/payment.types";
import { CreditService } from "../../credits/credit.service";
import { creditKey } from "../../credits/credit.types";
import { nextCreditResetFrom } from "../../credits/credit-policy.util";

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
    const policy = plan.creditPolicy;
    if (!policy) {
      this.logger.error(
        `Plan ${plan.id} (${plan.name}) has no CreditPolicy – refusing to settle invoice ${paidInvoice.id}`,
      );
      return;
    }

    const periodStart = new Date(paidInvoice.periodStart * 1000);
    const periodEnd = new Date(paidInvoice.periodEnd * 1000);
    const nextCreditResetAt = nextCreditResetFrom(periodStart, policy);

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

    const isInitial = paidInvoice.billingReason === "subscription_create";
    const eventType = isInitial
      ? SubscriptionEventType.CREATED
      : SubscriptionEventType.RENEWED;
    const description = isInitial
      ? `Credits granted – ${plan.name} (initial)`
      : `Credits granted – ${plan.name} (renewal)`;
    const paymentIntentId = paidInvoice.paymentIntentId ?? null;

    await this.prisma.$transaction(async (tx) => {
      const claimed = await this.invoiceService.claimAsPaid(
        tx,
        invoice.id,
        paidInvoice.billingReason ?? null,
      );

      if (!claimed) {
        this.logger.log(
          `Invoice ${invoice.id} already PAID (concurrent delivery) – skipping`,
        );
        return;
      }

      if (paymentIntentId) {
        await this.paymentService.recordSucceeded(
          {
            userId: subscription.userId,
            providerPaymentId: paymentIntentId,
            providerAmount: paidInvoice.amountPaid,
            currency: paidInvoice.currency,
            invoiceId: invoice.id,
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
      this.logger.log(
        `Subscription ${subscription.id} updated: status=ACTIVE, currentPeriodStart=${periodStart.toISOString()}, currentPeriodEnd=${periodEnd.toISOString()}, nextCreditResetAt=${nextCreditResetAt.toISOString()}`,
      );

      const isUpdate = paidInvoice.billingReason === "subscription_update";

      if (!isUpdate) {
        await this.creditService.revokeSubscriptionCredits(
          {
            userId: subscription.userId,
            description: `Unused credits expired before renewal`,
            referenceId: invoice.id,
            idempotencyKey: `revoke_sub_${invoice.id}`,
          },
          tx,
        );

        await this.creditService.grantSubscriptionAllowance(
          {
            userId: subscription.userId,
            amount: policy.creditAmount,
            description,
            referenceId: invoice.id,
            idempotencyKey: `grant_sub_${invoice.id}`,
          },
          tx,
        );
      }

      // Không còn bật/tắt ví ở đây: quyền tiêu addon được dẫn xuất từ gói hiện tại lúc đọc
      // (`isAddonUsable`). Trước đây `updateMany` này không tạo row, nên user mua addon
      // trước khi ví tồn tại sẽ có credit không bao giờ tiêu được.

      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: eventType,
          metadata: {
            stripeInvoiceId: paidInvoice.id,
            creditsGranted: policy.creditAmount,
            billingReason: paidInvoice.billingReason ?? null,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
          },
        },
      });

      this.logger.log(
        `Credits granted: subscription=${subscription.id} +${policy.creditAmount} (${plan.name}, ${paidInvoice.billingReason})`,
      );
    });
  }
}
