import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { InvoiceStatus, SubscriptionStatus, SubscriptionEventType } from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { formatStripeAmountToDatabase } from "../../utils/stripe-currency.util";
import { PaymentProvider, PaymentStatus } from "@prisma/client";

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
      const invoice = await tx.invoice.findFirst({
        where: { providerInvoiceId: stripeInvoice.id },
      });

      if (!invoice) {
        this.logger.error(`No local invoice found for Stripe invoice ${stripeInvoice.id}`);
        return;
      }

      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          status: InvoiceStatus.OPEN,
          retryCount: stripeInvoice.attempt_count,
          nextRetryAt: stripeInvoice.next_payment_attempt
            ? new Date(stripeInvoice.next_payment_attempt * 1000)
            : null,
        },
      });

      if (paymentIntentId && stripeSubscriptionId) {
        const tempSub = await tx.subscription.findFirst({
          where: { providerSubscriptionId: stripeSubscriptionId },
          select: { userId: true },
        });

        if (tempSub) {
          await tx.payment.upsert({
            where: { providerPaymentId: paymentIntentId },
            create: {
              userId: tempSub.userId,
              invoiceId: invoice.id,
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
      }

      if (!stripeSubscriptionId) return;

      const subscription = await tx.subscription.findFirst({
        where: { providerSubscriptionId: stripeSubscriptionId },
      });

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
