import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  Invoice,
  Subscription,
  InvoiceStatus,
  SubscriptionStatus,
  SubscriptionEventType,
  PaymentProvider,
  PaymentStatus,
} from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { StripeService } from "../../stripe.service";
import { formatStripeAmountToDatabase } from "../../utils/stripe-currency.util";


const MAX_RETRY_ATTEMPTS = 3;
const RETRY_WINDOW_MS = 3 * 86_400_000;

@Injectable()
export class InvoicePaymentFailedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaymentFailedStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
  ) {}
  private readonly invoicePaymentFailed = "invoice.payment_failed";
  canHandle(eventType: string): boolean {
    return eventType === this.invoicePaymentFailed;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const stripeInvoice = event.data.object as Stripe.Invoice;
    this.logger.log(`invoice.payment_failed: ${stripeInvoice.id} (attempt #${stripeInvoice.attempt_count})`);

    let line =stripeInvoice.lines?.data?.find(line => line.type === 'subscription') || stripeInvoice.lines?.data?.[0];
    let stripeSubscriptionId = line?.subscription ?? (line as any)?.parent?.subscription_item_details?.subscription ?? null;

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
              ? new Date(stripeInvoice.due_date * 1000)
              : new Date(stripeInvoice.period_end * 1000),
            ...retryData,
          },
        });
      } else {
        invoice = await tx.invoice.update({
          where: { providerInvoiceId: stripeInvoice.id },
          data: retryData,
        });

        if (!invoice) {
          this.logger.error(`No local invoice found for Stripe invoice ${stripeInvoice.id}`);
          return null;
        }

       
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

    await this.stripeService.cancelSubscriptionNow(stripeSubscriptionId);

    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: InvoiceStatus.UNCOLLECTIBLE, nextRetryAt: null },
    });
  }
}
