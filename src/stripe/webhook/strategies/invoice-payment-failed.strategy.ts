import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { SubscriptionStatus } from "@prisma/client";

@Injectable()
export class InvoicePaymentFailedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaymentFailedStrategy.name);

  constructor(private readonly prisma: PrismaService) {}
  private readonly INVOICE_PAYMENT_FAILED_EVENT = "invoice.payment_failed";
  canHandle(eventType: string): boolean {
    return eventType === this.INVOICE_PAYMENT_FAILED_EVENT;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const invoice = event.data.object as Stripe.Invoice;
    this.logger.warn(`Invoice payment failed: ${invoice.id}`);
    
    if (invoice.subscription) {
      const subscriptionId = invoice.subscription as string;

      // Update DB subscription status to PAST_DUE
      try {
        await this.prisma.subscription.updateMany({
          where: { providerSubscriptionId: subscriptionId },
          data: { status: SubscriptionStatus.PAST_DUE },
        });
        this.logger.log(`Marked subscription ${subscriptionId} as PAST_DUE.`);
      } catch (error) {
        this.logger.error(`Error updating subscription ${subscriptionId} to PAST_DUE`, error);
      }
    }
  }
}
