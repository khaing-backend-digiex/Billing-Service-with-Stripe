import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  Invoice,
  Subscription,
  SubscriptionStatus,
  SubscriptionEventType,
  InvoiceStatus,
  PaymentProvider,

} from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { InvoiceRecordService } from "../../invoice-record.service";
import { StripeService } from "../../stripe.service";
import { formatStripeAmountToDatabase } from "../../utils/stripe-currency.util";
import { CreditService } from "../../../credits/credit.service";
import { SubscriptionSyncService } from "../../sync/subscription-sync.service";
import {
  STRIPE_BILLING_REASON,
  STRIPE_INVOICE_LINE_TYPE,
  STRIPE_WEBHOOK_EVENT,
} from "../../../common/constants/stripe.constants";
import { fromUnixSeconds } from "../../../common/utils/date.util";

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_WINDOW_DAYS = 3;
const MS_PER_DAY = 86_400_000;
const RETRY_WINDOW_MS = RETRY_WINDOW_DAYS * MS_PER_DAY;

@Injectable()
export class InvoicePaymentFailedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaymentFailedStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly creditService: CreditService,
  ) { }
  private readonly invoicePaymentFailed = STRIPE_WEBHOOK_EVENT.INVOICE_PAYMENT_FAILED;
  canHandle(eventType: string): boolean {
    return eventType === this.invoicePaymentFailed;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const stripeInvoice = event.data.object as Stripe.Invoice;
    this.logger.log(`${this.invoicePaymentFailed}: ${stripeInvoice.id} (attempt #${stripeInvoice.attempt_count})`);

    let line = stripeInvoice.lines?.data?.find(line => line.type === STRIPE_INVOICE_LINE_TYPE.SUBSCRIPTION) || stripeInvoice.lines?.data?.[0];
    let stripeSubscriptionId = line?.subscription ?? (line as any)?.parent?.subscription_item_details?.subscription ?? null;

    const result = await this.prisma.$transaction(async (tx) => {
      const subscription = stripeSubscriptionId
        ? await tx.subscription.findFirst({
          where: { providerSubscriptionId: stripeSubscriptionId },
          include: { pricingOption: true },
        })
        : null;

      const retryData = {
        status: InvoiceStatus.OPEN,
        retryCount: stripeInvoice.attempt_count,
        nextRetryAt: stripeInvoice.next_payment_attempt
          ? fromUnixSeconds(stripeInvoice.next_payment_attempt)
          : null,
      };


      let invoice: Invoice | null = null;
      if (subscription) {
        invoice = await tx.invoice.upsert({
          where: { providerInvoiceId: stripeInvoice.id },
          update: retryData,
          create: {
            subscriptionId: subscription.id,
            provider: PaymentProvider.STRIPE,
            providerInvoiceId: stripeInvoice.id,
            amount: formatStripeAmountToDatabase(stripeInvoice.amount_due, stripeInvoice.currency),
            currency: stripeInvoice.currency,
            billingReason: stripeInvoice.billing_reason ?? null,
            dueAt: stripeInvoice.due_date
              ? fromUnixSeconds(stripeInvoice.due_date)
              : fromUnixSeconds(stripeInvoice.period_end),
            ...retryData,
          },
        });
      } else {
        const existingInvoice = await tx.invoice.findUnique({
          where: { providerInvoiceId: stripeInvoice.id },
        });

        if (!existingInvoice) {
          this.logger.error(`No local invoice found for Stripe invoice ${stripeInvoice.id}`);
          return null;
        }

        invoice = await tx.invoice.update({
          where: { id: existingInvoice.id },
          data: retryData,
        });
      }

      if (!stripeSubscriptionId) return { invoice, subscription: null };

      if (!subscription) {
        if (stripeSubscriptionId) {
          this.logger.error(
            `No local subscription found for Stripe subscription ${stripeSubscriptionId}`,
          );
        }
        return { invoice, subscription: null };
      }

      const isSubscriptionUpdate =
        stripeInvoice.billing_reason === STRIPE_BILLING_REASON.SUBSCRIPTION_UPDATE;

      if (isSubscriptionUpdate) {
        return;
      }

      const freshSub = await tx.subscription.findUnique({
        where: { id: subscription.id },
        select: { status: true },
      });

      const isTerminalStatus =
        freshSub?.status === SubscriptionStatus.CANCELLED ||
        freshSub?.status === SubscriptionStatus.EXPIRED;

      if (isTerminalStatus) {
        this.logger.log(
          `Subscription ${subscription.id} already ${freshSub.status} – skipping PAST_DUE downgrade`,
        );
        return;
      }

      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status: SubscriptionStatus.PAST_DUE,
        },
      });

      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: SubscriptionEventType.PAYMENT_FAILED,
          metadata: {
            stripeInvoiceId: stripeInvoice.id,
            attemptCount: stripeInvoice.attempt_count,
            nextPaymentAttempt: stripeInvoice.next_payment_attempt
              ? fromUnixSeconds(stripeInvoice.next_payment_attempt)
              : null,
          },
        },
      });

      return { invoice, subscription };
    });

    if (!result?.subscription || !stripeSubscriptionId) return;

    await this.cancelIfRetriesExhausted(result.invoice, result.subscription, stripeInvoice, stripeSubscriptionId);
  }


  private async cancelIfRetriesExhausted(
    invoice: Invoice,
    subscription: Subscription,
    stripeInvoice: Stripe.Invoice,
    stripeSubscriptionId: string,
  ): Promise<void> {
    const retriesUsed = (stripeInvoice.attempt_count ?? 1) - 1;
    const windowExceeded =
      Date.now() - invoice.createdAt.getTime() > RETRY_WINDOW_MS;

    if (retriesUsed < MAX_RETRY_ATTEMPTS && !windowExceeded) return;

    const current = await this.prisma.subscription.findUnique({
      where: { id: subscription.id },
      select: { status: true },
    });
    if (
      current?.status === SubscriptionStatus.CANCELLED ||
      current?.status === SubscriptionStatus.EXPIRED
    ) {
      this.logger.log(
        `Subscription ${subscription.id} already ${current.status} – skipping retry-exhausted cancellation`,
      );
      return;
    }

    this.logger.warn(
      `Retries exhausted for subscription ${subscription.id} ` +
      `(retries: ${retriesUsed}/${MAX_RETRY_ATTEMPTS}, window exceeded: ${windowExceeded}) – cancelling subscription`,
    );

    await this.stripeService.cancelSubscriptionNow(stripeSubscriptionId);

    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: InvoiceStatus.UNCOLLECTIBLE, nextRetryAt: null },
    });
  }
}
