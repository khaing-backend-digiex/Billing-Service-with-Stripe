import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { SubscriptionEventType, SubscriptionStatus } from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { InvoiceRecordService } from "../../invoice-record.service";
import { StripeService } from "../../stripe.service";
import {
  STRIPE_BILLING_REASON,
  STRIPE_INVOICE_LINE_TYPE,
  STRIPE_WEBHOOK_EVENT,
} from "../../../common/constants/stripe.constants";

@Injectable()
export class InvoicePaymentActionRequiredStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaymentActionRequiredStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoiceService: InvoiceRecordService,
    private readonly stripeService: StripeService,
  ) {}

  canHandle(eventType: string): boolean {
    return eventType === STRIPE_WEBHOOK_EVENT.INVOICE_PAYMENT_ACTION_REQUIRED;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const invoice = this.stripeService.mapRawInvoice(event.data.object);
    this.logger.warn(`invoice.payment_action_required: ${invoice.id}`);

    const line =
      invoice.lines.find((l) => l.type === STRIPE_INVOICE_LINE_TYPE.SUBSCRIPTION) ??
      invoice.lines[0];
    const stripeSubscriptionId = invoice.subscriptionId ?? line?.subscriptionId ?? null;

    if (!stripeSubscriptionId) {
      this.logger.error(`Invoice ${invoice.id} has no linked subscription, skipping`);
      return;
    }

    const subscription = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: stripeSubscriptionId },
    });

    if (!subscription) {
      this.logger.error(
        `No local subscription found for Stripe subscription ${stripeSubscriptionId}`,
      );
      return;
    }

    const localInvoice = await this.invoiceService.ensureLocal(
      invoice,
      subscription.id,
    );

    const isInitial = invoice.billingReason === STRIPE_BILLING_REASON.SUBSCRIPTION_CREATE;
    const status = isInitial
      ? SubscriptionStatus.INCOMPLETE
      : SubscriptionStatus.PAST_DUE;
    await this.prisma.$transaction([
      this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { status },
      }),
      this.prisma.subscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: SubscriptionEventType.PAYMENT_ACTION_REQUIRED,
          metadata: {
            stripeInvoiceId: invoice.id,
            localInvoiceId: localInvoice.id,
            paymentIntentId: invoice.paymentIntentId ?? null,
            billingReason: invoice.billingReason ?? null,
          },
        },
      }),
    ]);

    this.logger.log(
      `Subscription ${subscription.id} → ${status} (3DS required for invoice ${invoice.id})`,
    );
  }
}
