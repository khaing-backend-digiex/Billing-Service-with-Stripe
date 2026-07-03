import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PaidInvoiceSyncService } from "../../sync/paid-invoice-sync.service";

@Injectable()
export class InvoicePaidStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaidStrategy.name);

  constructor(private readonly paidInvoiceSync: PaidInvoiceSyncService) { }

  private readonly invoicePaid = "invoice.paid";
  canHandle(eventType: string): boolean {
    return eventType === this.invoicePaid;
  }

  
  async handle(event: Stripe.Event): Promise<void> {
    const stripeInvoice = event.data.object as Stripe.Invoice;
    this.logger.log(`invoice.paid: ${stripeInvoice.id}`);

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

    if (!stripeSubscriptionId) {
      this.logger.log(`Invoice ${stripeInvoice.id} has no linked subscription, skipping`);
      return;
    }

    await this.paidInvoiceSync.applyPaidInvoice(stripeInvoice, stripeSubscriptionId);
  }
}
