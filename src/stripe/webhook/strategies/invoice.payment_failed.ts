import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  Invoice,
  Subscription,
  SubscriptionStatus,
  SubscriptionEventType,
} from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { InvoiceService } from "../../invoice.service";
import { StripeService } from "../../stripe.service";
import { PaymentInvoice } from "../../../payments/types/payment.types";
import { STRIPE_INVOICE_LINE_TYPE } from "../../../common/constants/stripe.constants";

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_WINDOW_MS = 3 * 86_400_000;

@Injectable()
export class InvoicePaymentFailedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaymentFailedStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly invoiceService: InvoiceService,
  ) {}

  private readonly invoicePaymentFailed = "invoice.payment_failed";
  canHandle(eventType: string): boolean {
    return eventType === this.invoicePaymentFailed;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const failedInvoice = this.stripeService.mapRawInvoice(event.data.object);
    this.logger.log(
      `invoice.payment_failed: ${failedInvoice.id} (attempt #${failedInvoice.attemptCount})`,
    );

    const line =
      failedInvoice.lines.find(
        (l) => l.type === STRIPE_INVOICE_LINE_TYPE.SUBSCRIPTION,
      ) ?? failedInvoice.lines[0];
    const stripeSubscriptionId =
      failedInvoice.subscriptionId ?? line?.subscriptionId ?? null;

    const result = await this.prisma.$transaction(async (tx) => {
      const subscription = stripeSubscriptionId
        ? await tx.subscription.findFirst({
            where: { providerSubscriptionId: stripeSubscriptionId },
          })
        : null;

      const invoice = await this.invoiceService.recordFailedAttempt(
        tx,
        failedInvoice,
        subscription?.id ?? null,
      );

      if (!invoice) return null;

      if (!subscription) {
        if (stripeSubscriptionId) {
          this.logger.error(
            `No local subscription found for Stripe subscription ${stripeSubscriptionId}`,
          );
        }
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
            stripeInvoiceId: failedInvoice.id,
            attemptCount: failedInvoice.attemptCount,
            nextPaymentAttempt: failedInvoice.nextPaymentAttempt ?? null,
          },
        },
      });

      return { invoice, subscription };
    });

    if (!result?.subscription || !stripeSubscriptionId) return;

    await this.cancelIfRetriesExhausted(
      result.invoice,
      result.subscription,
      failedInvoice,
      stripeSubscriptionId,
    );
  }

  private async cancelIfRetriesExhausted(
    invoice: Invoice,
    subscription: Subscription,
    failedInvoice: PaymentInvoice,
    stripeSubscriptionId: string,
  ): Promise<void> {
    const retriesUsed = (failedInvoice.attemptCount ?? 1) - 1;
    const windowExceeded =
      Date.now() - invoice.createdAt.getTime() > RETRY_WINDOW_MS;

    if (retriesUsed < MAX_RETRY_ATTEMPTS && !windowExceeded) return;

    this.logger.warn(
      `Retries exhausted for subscription ${subscription.id} ` +
        `(retries: ${retriesUsed}/${MAX_RETRY_ATTEMPTS}, window exceeded: ${windowExceeded}) – cancelling`,
    );

    await this.stripeService.cancelSubscriptionNow(stripeSubscriptionId);
    await this.invoiceService.markUncollectible(invoice.id);
  }
}
