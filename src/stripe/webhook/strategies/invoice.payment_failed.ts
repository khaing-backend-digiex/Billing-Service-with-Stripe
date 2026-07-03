import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  InvoiceStatus,
  SubscriptionStatus,
  SubscriptionEventType,
} from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { formatStripeAmountToDatabase } from "../../utils/stripe-currency.util";
import { PaymentProvider, PaymentStatus } from "@prisma/client";

@Injectable()
export class InvoicePaymentFailedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaymentFailedStrategy.name);

  constructor(private readonly prisma: PrismaService) {}
  private readonly invoicePaymentFailed = "invoice.payment_failed";
  canHandle(eventType: string): boolean {
    return eventType === this.invoicePaymentFailed;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const stripeInvoice = event.data.object as Stripe.Invoice;
    this.logger.log(`invoice.payment_failed: ${stripeInvoice.id} (attempt #${stripeInvoice.attempt_count})`);

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

    const paymentIntentId =
      typeof stripeInvoice.payment_intent === "string"
        ? stripeInvoice.payment_intent
        : (stripeInvoice.payment_intent as any)?.id ?? null;

    await this.prisma.$transaction(async (tx) => {
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
      if (subscription) {
        await tx.invoice.upsert({
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

        // Ghi nhận Payment record nếu có paymentIntentId
        if (paymentIntentId) {
          await tx.payment.upsert({
            where: { providerPaymentId: paymentIntentId },
            create: {
              userId: subscription.userId,
              invoiceId: (await tx.invoice.findFirst({ where: { providerInvoiceId: stripeInvoice.id } }))?.id ?? undefined,
              provider: PaymentProvider.STRIPE,
              providerPaymentId: paymentIntentId,
              amount: formatStripeAmountToDatabase(stripeInvoice.amount_due, stripeInvoice.currency),
              currency: stripeInvoice.currency,
              status: PaymentStatus.FAILED,
              paidAt: null,
            },
            update: {
              status: PaymentStatus.FAILED,
              paidAt: null,
            },
          });
        }

        // Update subscription status to PAST_DUE
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
      } else {
        // Không tìm thấy subscription local — chỉ update invoice nếu có
        const invoice = await tx.invoice.findFirst({
          where: { providerInvoiceId: stripeInvoice.id },
        });

        if (!invoice) {
          this.logger.error(`No local invoice or subscription found for Stripe invoice ${stripeInvoice.id}`);
          return;
        }

        await tx.invoice.update({
          where: { id: invoice.id },
          data: retryData,
        });
      }
    });
  }
}
