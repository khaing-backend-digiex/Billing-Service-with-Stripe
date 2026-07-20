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
    const paidInvoice = this.stripeService.mapRawInvoice(event.data.object);
    this.logger.debug(`invoice.paid: ${JSON.stringify(paidInvoice)}`);
    const lineToUse =
      paidInvoice.lines.find(line => line.type === "subscription" && !line.isProration) ??
      paidInvoice.lines.find(line => !line.isProration && line.subscriptionId) ??
      paidInvoice.lines.find(line => line.type === "subscription") ??
      paidInvoice.lines[0];
    const stripeSubscriptionId = paidInvoice.subscriptionId ?? lineToUse?.subscriptionId ?? null;

    if (!stripeSubscriptionId) {
      this.logger.error(
        `Invoice ${paidInvoice.id} has no linked subscription, skipping`,
      );
      return;
    }

    if (!paidInvoice.customerId) {
      this.logger.error(`Invoice ${paidInvoice.id} has no customer, skipping`);
      return;
    }

    const user = await this.prisma.user.findFirst({
      where: { providerCustomerId: paidInvoice.customerId },
      select: { id: true },
    });

    if (!user) {
      this.logger.error(
        `No user found for Stripe customer ${paidInvoice.customerId}`,
      );
      return;
    }

    const priceId = lineToUse?.priceId;

    if (!priceId) {
      this.logger.error(`No price ID found in invoice lines.`);
      return;
    }

    const pricingOption =
      await this.pricingService.findByProviderPriceId(priceId);
    if (!pricingOption) {
      this.logger.error(`No pricing option found for priceId ${priceId}`);
      return;
    }

    const periodStart = new Date((lineToUse?.periodStart ?? paidInvoice.periodStart) * 1000);
    const periodEnd = new Date((lineToUse?.periodEnd ?? paidInvoice.periodEnd) * 1000);

    let subscription = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: stripeSubscriptionId }
    });

    if (subscription) {
      subscription = await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: SubscriptionStatus.ACTIVE,
          pricingOptionId: pricingOption.id,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          nextCreditResetAt: periodEnd,
        }
      });
    } else {
      await this.prisma.subscription.updateMany({
        where: {
          userId: user.id,
          productId: pricingOption.plan.productId,
          status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE, SubscriptionStatus.TRIALING] }
        },
        data: { status: SubscriptionStatus.EXPIRED }
      });

      subscription = await this.prisma.subscription.create({
        data: {
          userId: user.id,
          productId: pricingOption.plan.productId,
          status: SubscriptionStatus.ACTIVE,
          pricingOptionId: pricingOption.id,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          nextCreditResetAt: periodEnd,
          provider: PaymentProvider.STRIPE,
          providerSubscriptionId: stripeSubscriptionId,
        }
      });
    }

    await this.paidInvoiceSync.applyPaidInvoice(paidInvoice, subscription.id);
  }
}
