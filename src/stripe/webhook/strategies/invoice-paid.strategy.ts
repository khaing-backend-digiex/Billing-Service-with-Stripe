import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PaymentProvider, SubscriptionStatus } from "@prisma/client";
import { PrismaService } from "@/database/prisma.service";
import { PricingService } from "@/pricing/pricing.service";
import { PaidInvoiceSyncService } from "../../sync/paid-invoice-sync.service";
import { StripeService } from "../../stripe.service";

const LIVE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.TRIALING,
];
const TERMINAL_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.EXPIRED,
  SubscriptionStatus.CANCELLED,
];

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

    const existing = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: stripeSubscriptionId }
    });

    if (existing && TERMINAL_STATUSES.includes(existing.status)) {
      this.logger.warn(
        `Subscription ${existing.id} is ${existing.status} – ignoring late invoice ` +
        `${paidInvoice.id} for dead Stripe subscription ${stripeSubscriptionId}`,
      );
      return;
    }

    let subscription;
    let supersededStripeSubIds: string[] = [];

    if (existing) {
      subscription = existing;
    } else {
      const result = await this.prisma.$transaction(async (tx) => {
        const superseded = await tx.subscription.findMany({
          where: {
            userId: user.id,
            productId: pricingOption.plan.productId,
            status: { in: LIVE_STATUSES },
          },
          select: { id: true, providerSubscriptionId: true },
        });

        await tx.subscription.updateMany({
          where: { id: { in: superseded.map((s) => s.id) } },
          data: { status: SubscriptionStatus.EXPIRED },
        });

        const created = await tx.subscription.create({
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

        return { created, superseded };
      });

      subscription = result.created;
      supersededStripeSubIds = result.superseded
        .map((s) => s.providerSubscriptionId)
        .filter((id): id is string => !!id && id !== stripeSubscriptionId);
    }

    await this.paidInvoiceSync.applyPaidInvoice(paidInvoice, subscription.id);

    for (const supersededId of supersededStripeSubIds) {
      try {
        await this.stripeService.cancelSubscriptionNow(supersededId);
        this.logger.log(
          `Cancelled superseded Stripe subscription ${supersededId} (replaced by ${stripeSubscriptionId})`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to cancel superseded Stripe subscription ${supersededId}: ` +
          `${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}
