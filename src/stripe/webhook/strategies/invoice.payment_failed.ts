import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  Invoice,
  Subscription,
  InvoiceStatus,
  SubscriptionStatus,
  SubscriptionEventType,
  PaymentProvider,
} from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { StripeService } from "../../stripe.service";

// Business rule: tối đa 3 lần retry trong 3 ngày. attempt_count của Stripe
// tính cả lần charge đầu tiên → retry đã dùng = attempt_count - 1.
// Lưu ý: lịch retry (thời điểm từng lần) do Stripe Smart Retries quyết định —
// cần cấu hình dashboard 3 retries/3 days cho khớp; code này là chốt chặn
// cứng: quá số lần HOẶC quá cửa sổ 3 ngày là hủy, bất kể dashboard để gì.
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_WINDOW_MS = 3 * 86_400_000;

@Injectable()
export class InvoicePaymentFailedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaymentFailedStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
  ) {}
  private readonly invoicePaymentFailed = "invoice.payment_failed"
  canHandle(eventType: string): boolean {
    return eventType === this.invoicePaymentFailed;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const stripeInvoice = event.data.object as Stripe.Invoice;
    this.logger.log(`invoice.payment_failed: ${stripeInvoice.id} (attempt #${stripeInvoice.attempt_count})`);

    const stripeSubscriptionId =
      typeof stripeInvoice.subscription === "string"
        ? stripeInvoice.subscription
        : stripeInvoice.subscription?.id ?? null;

    const result = await this.prisma.$transaction(async (tx) => {
      const subscription = stripeSubscriptionId
        ? await tx.subscription.findFirst({
            where: { providerSubscriptionId: stripeSubscriptionId },
          })
        : null;

      const retryData = {
        status: InvoiceStatus.OPEN,
        retryCount: stripeInvoice.attempt_count,
        nextRetryAt: stripeInvoice.next_payment_attempt
          ? new Date(stripeInvoice.next_payment_attempt * 1000)
          : null,
      };

      // Stripe không đảm bảo thứ tự webhook: invoice.payment_failed có thể tới
      // trước invoice.created → upsert để không mất retry info.
      let invoice: Invoice | null = null;
      if (subscription) {
        invoice = await tx.invoice.upsert({
          where: { providerInvoiceId: stripeInvoice.id },
          update: retryData,
          create: {
            subscriptionId: subscription.id,
            provider: PaymentProvider.STRIPE,
            providerInvoiceId: stripeInvoice.id,
            amount: stripeInvoice.amount_due / 100,
            currency: stripeInvoice.currency,
            billingReason: stripeInvoice.billing_reason ?? null,
            dueAt: stripeInvoice.due_date
              ? new Date(stripeInvoice.due_date * 1000)
              : new Date(stripeInvoice.period_end * 1000),
            ...retryData,
          },
        });
      } else {
        invoice = await tx.invoice.findFirst({
          where: { providerInvoiceId: stripeInvoice.id },
        });

        if (!invoice) {
          this.logger.error(`No local invoice found for Stripe invoice ${stripeInvoice.id}`);
          return null;
        }

        invoice = await tx.invoice.update({
          where: { id: invoice.id },
          data: retryData,
        });
      }

      if (!stripeSubscriptionId) return { invoice, subscription: null };

      if (!subscription) {
        this.logger.error(`No local subscription found for Stripe subscription ${stripeSubscriptionId}`);
        return { invoice, subscription: null };
      }

      await tx.subscription.update({
        where: { id: subscription.id },
        data: { status: SubscriptionStatus.PAST_DUE },
      });

      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: SubscriptionEventType.PAYMENT_FAILED,
          metadata: {
            stripeInvoiceId: stripeInvoice.id,
            attemptCount: stripeInvoice.attempt_count,
            nextPaymentAttempt: stripeInvoice.next_payment_attempt ?? null,
          },
        },
      });

      return { invoice, subscription };
    });

    if (!result?.subscription || !result.invoice || !stripeSubscriptionId) return;

    await this.cancelIfRetriesExhausted(result.invoice, result.subscription, stripeInvoice, stripeSubscriptionId);
  }

  /**
   * Chốt chặn business rule: quá 3 lần retry HOẶC quá 3 ngày kể từ khi invoice
   * bắt đầu fail → hủy subscription ngay trên Stripe. Webhook
   * customer.subscription.deleted sau đó sẽ set CANCELLED + downgrade về Free.
   */
  private async cancelIfRetriesExhausted(
    invoice: Invoice,
    subscription: Subscription,
    stripeInvoice: Stripe.Invoice,
    stripeSubscriptionId: string,
  ): Promise<void> {
    const retriesUsed = (stripeInvoice.attempt_count ?? 1) - 1;
    const windowExceeded = Date.now() - invoice.createdAt.getTime() > RETRY_WINDOW_MS;

    if (retriesUsed < MAX_RETRY_ATTEMPTS && !windowExceeded) return;

    this.logger.warn(
      `Retries exhausted for subscription ${subscription.id} ` +
        `(retries: ${retriesUsed}/${MAX_RETRY_ATTEMPTS}, window exceeded: ${windowExceeded}) – cancelling`,
    );

    // Hủy trên Stripe trước; nếu fail thì throw → Stripe retry event này,
    // cancelSubscriptionNow idempotent nên retry an toàn.
    await this.stripeService.cancelSubscriptionNow(stripeSubscriptionId);

    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: InvoiceStatus.UNCOLLECTIBLE, nextRetryAt: null },
    });
  }
}
