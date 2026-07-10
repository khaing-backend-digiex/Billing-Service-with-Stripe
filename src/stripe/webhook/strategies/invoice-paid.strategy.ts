import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PaymentProvider, SubscriptionStatus } from "@prisma/client";
import { PrismaService } from "@/database/prisma.service";
import { PricingService } from "@/pricing/pricing.service";
import { PaidInvoiceSyncService } from "../../sync/paid-invoice-sync.service";

@Injectable()
export class InvoicePaidStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaidStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
    private readonly paidInvoiceSync: PaidInvoiceSyncService,
  ) { }

  private readonly invoicePaid = "invoice.paid";
  canHandle(eventType: string): boolean {
    return eventType === this.invoicePaid;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const stripeInvoice = event.data.object as Stripe.Invoice;
    this.logger.log(`invoice.paid: ${stripeInvoice.id}`);

    const lineToUse = stripeInvoice.lines?.data?.find(line => line.type === 'subscription') || stripeInvoice.lines?.data?.[0];
    const stripeSubscriptionId = lineToUse?.subscription ?? (lineToUse as any)?.parent?.subscription_item_details?.subscription ?? null;

    if (!stripeSubscriptionId) {
      this.logger.error(`Invoice ${stripeInvoice.id} has no linked subscription, skipping`);
      return;
    }

    const user = await this.prisma.user.findFirst({
      where: { providerCustomerId: stripeInvoice.customer as string },
      select: { id: true },
    });

    if (!user) {
      this.logger.error(`No user found for Stripe customer ${stripeInvoice.customer}`);
      return;
    }

    const priceId = (lineToUse as any)?.pricing?.price_details?.price ?? lineToUse?.price?.id;

    if (!priceId) {
      this.logger.error(`No price ID found in invoice lines.`);
      return;
    }

    const pricingOption = await this.pricingService.findByProviderPriceId(priceId);
    if (!pricingOption) {
      this.logger.error(`No pricing option found for priceId ${priceId}`);
      return;
    }

    const periodStart = new Date(stripeInvoice.period_start * 1000);
    const periodEnd = new Date(stripeInvoice.period_end * 1000);

    const subscription = await this.prisma.subscription.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        status: SubscriptionStatus.ACTIVE,
        pricingOptionId: pricingOption.id,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        subscriptionCreditsRemaining: 0,
        nextCreditResetAt: periodEnd,
        provider: PaymentProvider.STRIPE,
        providerSubscriptionId: stripeSubscriptionId,
      },
      update: {},
    });

    await this.paidInvoiceSync.applyPaidInvoice(stripeInvoice, subscription.id);
  }
}
