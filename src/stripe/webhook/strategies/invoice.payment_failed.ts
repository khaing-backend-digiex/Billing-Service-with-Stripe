import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  InvoiceStatus,
  SubscriptionStatus,
  SubscriptionEventType,
  PaymentProvider,
} from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";

@Injectable()
export class InvoicePaymentFailedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaymentFailedStrategy.name);

  constructor(private readonly prisma: PrismaService) {}
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
        const invoice = await tx.invoice.findFirst({
          where: { providerInvoiceId: stripeInvoice.id },
        });

        if (!invoice) {
          this.logger.error(`No local invoice found for Stripe invoice ${stripeInvoice.id}`);
          return;
        }

        await tx.invoice.update({
          where: { id: invoice.id },
          data: retryData,
        });
      }

      if (!stripeSubscriptionId) return;

      if (!subscription) {
        this.logger.error(`No local subscription found for Stripe subscription ${stripeSubscriptionId}`);
        return;
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
    });
  }
}
