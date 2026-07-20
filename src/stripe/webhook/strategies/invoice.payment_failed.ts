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
import { InvoiceRecordService } from "../../invoice-record.service";
import { StripeService } from "../../stripe.service";
import { PaymentInvoice } from "../../../payments/types/payment.types";
import { STRIPE_INVOICE_LINE_TYPE } from "../../../common/constants/stripe.constants";
import { PLAN_CODES } from "@/common/constants/plan.constants";

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_WINDOW_MS = 3 * 86_400_000;

@Injectable()
export class InvoicePaymentFailedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaymentFailedStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoiceService: InvoiceRecordService,
    private readonly stripeService: StripeService,
  ) { }
  private readonly invoicePaymentFailed = "invoice.payment_failed";
  canHandle(eventType: string): boolean {
    return eventType === this.invoicePaymentFailed;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const stripeInvoice = this.stripeService.mapRawInvoice(event.data.object);
    this.logger.log(`invoice.payment_failed: ${stripeInvoice.id} (attempt #${stripeInvoice.attemptCount})`);

    const line =
      stripeInvoice.lines.find((l) => l.type === STRIPE_INVOICE_LINE_TYPE.SUBSCRIPTION) ??
      stripeInvoice.lines[0];
    const stripeSubscriptionId = stripeInvoice.subscriptionId ?? line?.subscriptionId ?? null;

    const result = await this.prisma.$transaction(async (tx) => {
      const subscription = stripeSubscriptionId
        ? await tx.subscription.findFirst({
          where: { providerSubscriptionId: stripeSubscriptionId },
        })
        : null;

      const invoice = await this.invoiceService.recordFailedAttempt(
        tx,
        stripeInvoice,
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

      const isUpdate = stripeInvoice.billingReason === 'subscription_update';

      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status: isUpdate ? undefined : SubscriptionStatus.PAST_DUE,
        },
      });

      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: SubscriptionEventType.PAYMENT_FAILED,
          metadata: {
            stripeInvoiceId: stripeInvoice.id,
            attemptCount: stripeInvoice.attemptCount,
            nextPaymentAttempt: stripeInvoice.nextPaymentAttempt
              ? new Date(stripeInvoice.nextPaymentAttempt * 1000)
              : null,
          },
        },
      });

      return { invoice, subscription };
    });

    if (!result?.subscription || !stripeSubscriptionId) return;

    await this.downgradeToFreeIfRetriesExhausted(result.invoice, result.subscription, stripeInvoice, stripeSubscriptionId);
  }


  private async downgradeToFreeIfRetriesExhausted(
    invoice: Invoice,
    subscription: Subscription,
    stripeInvoice: PaymentInvoice,
    stripeSubscriptionId: string,
  ): Promise<void> {
    const retriesUsed = (stripeInvoice.attemptCount ?? 1) - 1;
    const windowExceeded =
      Date.now() - invoice.createdAt.getTime() > RETRY_WINDOW_MS;

    if (retriesUsed < MAX_RETRY_ATTEMPTS && !windowExceeded) return;

    this.logger.warn(
      `Retries exhausted for subscription ${subscription.id} ` +
      `(retries: ${retriesUsed}/${MAX_RETRY_ATTEMPTS}, window exceeded: ${windowExceeded}) – downgrading to free`,
    );

    const freePlan = await this.prisma.plan.findFirst({
      where: { code: PLAN_CODES.FREE
       },
      include: { pricingOptions: true },
    });
    const freePricingOption = freePlan?.pricingOptions?.[0];

    if (!freePricingOption?.providerPriceId) {
      await this.stripeService.cancelSubscriptionNow(stripeSubscriptionId);
      return;
    }

    await this.stripeService.cancelSubscriptionNow(stripeSubscriptionId);

    await this.invoiceService.markUncollectible(invoice.id);
  }
}
