import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PaymentProvider, SubscriptionStatus } from "@prisma/client";
import { PrismaService } from "@/database/prisma.service";
import { PricingService } from "@/pricing/pricing.service";
import { PaidInvoiceSyncService } from "../../sync/paid-invoice-sync.service";
import { StripeService } from "../../stripe.service";

@Injectable()
export class InvoicePaidStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaidStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
    private readonly paidInvoiceSync: PaidInvoiceSyncService,
    private readonly stripeService: StripeService,
  ) { }

  private readonly invoicePaid = "invoice.paid";
  canHandle(eventType: string): boolean {
    return eventType === this.invoicePaid;
  }

  async handle(event: Stripe.Event): Promise<void> {
    this.logger.log(`invoice.paid: {${JSON.stringify(event.data.object)}}`);
    const paidInvoice = this.stripeService.mapRawInvoice(event.data.object);
    this.logger.log(`invoice.paid: ${paidInvoice.id}`);
    this.logger.debug(`invoice.paid: ${JSON.stringify(paidInvoice)}`);
    const lineToUse =
      paidInvoice.lines.find(line => line.type === "subscription") ?? paidInvoice.lines[0];
    const stripeSubscriptionId = paidInvoice.subscriptionId ?? lineToUse?.subscriptionId ?? null;

    if (!stripeSubscriptionId) {
      this.logger.error(`Invoice ${paidInvoice.id} has no linked subscription, skipping`);
      return;
    }

    // Prisma bỏ qua filter undefined → phải chặn sớm, nếu không sẽ khớp nhầm user bất kỳ.
    if (!paidInvoice.customerId) {
      this.logger.error(`Invoice ${paidInvoice.id} has no customer, skipping`);
      return;
    }

    const user = await this.prisma.user.findFirst({
      where: { providerCustomerId: paidInvoice.customerId },
      select: { id: true },
    });

    if (!user) {
      this.logger.error(`No user found for Stripe customer ${paidInvoice.customerId}`);
      return;
    }

    const priceId = lineToUse?.priceId;

    if (!priceId) {
      this.logger.error(`No price ID found in invoice lines.`);
      return;
    }

    const pricingOption = await this.pricingService.findByProviderPriceId(priceId);
    if (!pricingOption) {
      this.logger.error(`No pricing option found for priceId ${priceId}`);
      return;
    }

    const periodStart = new Date(paidInvoice.periodStart * 1000);
    const periodEnd = new Date(paidInvoice.periodEnd * 1000);

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

    await this.paidInvoiceSync.applyPaidInvoice(paidInvoice, subscription.id);
  }
}
