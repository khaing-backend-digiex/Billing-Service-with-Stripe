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
import { PaymentInvoice } from "../../../payments/types/payment.types";
import { STRIPE_INVOICE_LINE_TYPE } from "../../../common/constants/stripe.constants";
import { PLAN_CODES } from "@/common/constants/plan.constants";
import { CreditService } from "../../../credits/credit.service";
import { SubscriptionSyncService } from "../../sync/subscription-sync.service";


const MAX_RETRY_ATTEMPTS = 3;
const RETRY_WINDOW_MS = 3 * 86_400_000;

@Injectable()
export class InvoicePaymentFailedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaymentFailedStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoiceService: InvoiceRecordService,
    private readonly stripeService: StripeService,
    private readonly creditService: CreditService,
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
          include: { pricingOption: true },
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

      const isSubscriptionUpdate = stripeInvoice.billingReason === 'subscription_update';

      if (isSubscriptionUpdate) {
        this.logger.warn(
          `Proration/upgrade invoice ${stripeInvoice.id} payment failed for subscription ${subscription.id}. The failed attempt was recorded, but no status downgrade is applied automatically for mid-cycle updates.`,
        );
        return { invoice, subscription: null };
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

      const productId =
        subscription.productId ?? subscription.pricingOption?.productId;

      if (!productId) {
        return;
      }

      await this.creditService.revokeSubscriptionCredits(
        {
          userId: subscription.userId,
          productId,
          description: `Subscription past due: ${subscription.id}`,
          subscriptionId: subscription.id,
          idempotencyKey: `revoke_past_due_${stripeInvoice.id}`,
        },
        tx
      );


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

    await this.cancelIfRetriesExhausted(result.invoice, result.subscription, stripeInvoice, stripeSubscriptionId);
  }


  private async cancelIfRetriesExhausted(
    invoice: Invoice,
    subscription: Subscription,
    stripeInvoice: PaymentInvoice,
    stripeSubscriptionId: string,
  ): Promise<void> {
    const retriesUsed = (stripeInvoice.attemptCount ?? 1) - 1;
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

    await this.invoiceService.markUncollectible(invoice.id);
  }
}
