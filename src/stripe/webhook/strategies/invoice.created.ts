import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { InvoiceStatus, PaymentProvider } from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { formatStripeAmountToDatabase } from "../../utils/stripe-currency.util";

const STRIPE_INVOICE_STATUS_MAP: Record<string, InvoiceStatus> = {
  draft: InvoiceStatus.DRAFT,
  open: InvoiceStatus.OPEN,
  paid: InvoiceStatus.PAID,
  void: InvoiceStatus.VOID,
  uncollectible: InvoiceStatus.UNCOLLECTIBLE,
};

@Injectable()
export class InvoiceCreatedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoiceCreatedStrategy.name);

  constructor(private readonly prisma: PrismaService) {}

  private readonly invoiceCreated = "invoice.created";
  canHandle(eventType: string): boolean {
    return eventType === this.invoiceCreated;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const stripeInvoice = event.data.object as Stripe.Invoice;
    this.logger.log(`invoice.created: ${stripeInvoice.id}`);

    const stripeSubscriptionId =
      typeof stripeInvoice.subscription === "string"
        ? stripeInvoice.subscription
        : stripeInvoice.subscription?.id ?? null;

    if (!stripeSubscriptionId) {
      this.logger.log(`Invoice ${stripeInvoice.id} has no linked subscription, skipping`);
      return;
    }

    const existing = await this.prisma.invoice.findFirst({
      where: { providerInvoiceId: stripeInvoice.id },
    });

    if (existing) {
      this.logger.log(`Invoice ${stripeInvoice.id} already exists, skipping`);
      return;
    }

    const subscription = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: stripeSubscriptionId },
    });

    if (!subscription) {
      this.logger.error(`No local subscription found for Stripe subscription ${stripeSubscriptionId}`);
      return;
    }

    const status = STRIPE_INVOICE_STATUS_MAP[stripeInvoice.status ?? "draft"] ?? InvoiceStatus.DRAFT;
    const amount = formatStripeAmountToDatabase(stripeInvoice.amount_due, stripeInvoice.currency);
    const dueAt = stripeInvoice.due_date
      ? new Date(stripeInvoice.due_date * 1000)
      : new Date(stripeInvoice.period_end * 1000);

    await this.prisma.invoice.create({
      data: {
        subscriptionId: subscription.id,
        provider: PaymentProvider.STRIPE,
        providerInvoiceId: stripeInvoice.id,
        amount,
        currency: stripeInvoice.currency,
        status,
        dueAt,
      },
    });

    this.logger.log(`Invoice ${stripeInvoice.id} created for subscription ${subscription.id}`);
  }
}
