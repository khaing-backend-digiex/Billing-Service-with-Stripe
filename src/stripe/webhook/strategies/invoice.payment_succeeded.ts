import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  InvoiceStatus,
  SubscriptionStatus,
  CreditTransactionType,
  ReferenceType,
  SubscriptionEventType,
} from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { PricingService } from "../../../pricing/pricing.service";

@Injectable()
export class InvoicePaymentSucceededStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaymentSucceededStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
  ) {}
  private readonly InvoicePaymentSucceeded = "invoice.payment_succeeded"
  canHandle(eventType: string): boolean {
    return eventType === this.InvoicePaymentSucceeded;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const stripeInvoice = event.data.object as Stripe.Invoice;
    this.logger.log(`invoice.payment_succeeded: ${stripeInvoice.id}`);

    const stripeSubscriptionId =
      typeof stripeInvoice.subscription === "string"
        ? stripeInvoice.subscription
        : stripeInvoice.subscription?.id ?? null;

    if (!stripeSubscriptionId) {
      this.logger.error(`Invoice ${stripeInvoice.id} has no linked subscription`);
      return;
    }

    const invoice = await this.prisma.invoice.findFirst({
      where: { providerInvoiceId: stripeInvoice.id },
    });

    if (!invoice) {
      this.logger.error(`No local invoice found for Stripe invoice ${stripeInvoice.id}`);
      return;
    }

    if (invoice.status === InvoiceStatus.PAID) {
      this.logger.log(`Invoice ${invoice.id} already PAID – skipping`);
      return;
    }

    const subscription = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: stripeSubscriptionId },
    });

    if (!subscription) {
      this.logger.error(`No local subscription found for Stripe subscription ${stripeSubscriptionId}`);
      return;
    }

    const periodStart = new Date(stripeInvoice.period_start * 1000);
    const periodEnd = new Date(stripeInvoice.period_end * 1000);
    const isRenewal = stripeInvoice.billing_reason === "subscription_cycle";

    let pricingOption: Awaited<ReturnType<typeof this.pricingService.findByProviderPriceId>> | null = null;
    if (isRenewal) {
      const priceId = stripeInvoice.lines.data[0]?.price?.id;
      if (!priceId) {
        this.logger.error(`No price ID in invoice ${stripeInvoice.id} lines`);
        return;
      }
      pricingOption = await this.pricingService.findByProviderPriceId(priceId);
      if (!pricingOption) {
        this.logger.error(`No pricing option found for priceId ${priceId}`);
        return;
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: InvoiceStatus.PAID, paidAt: new Date() },
      });

      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        },
      });

      if (!isRenewal || !pricingOption) return;

      const plan = pricingOption.plan;
      const nextCreditResetAt = new Date(
        periodStart.getTime() + plan.resetIntervalDay * 86_400_000,
      );

      await tx.creditTransaction.create({
        data: {
          userId: subscription.userId,
          type: CreditTransactionType.RENEWAL,
          amount: plan.renewalCredits,
          description: `Auto-renewal – ${plan.name}`,
          referenceType: ReferenceType.SUBSCRIPTION,
          referenceId: subscription.id,
        },
      });

      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          subscriptionCreditsRemaining: plan.renewalCredits,
          nextCreditResetAt,
        },
      });

      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: SubscriptionEventType.RENEWED,
          metadata: {
            stripeInvoiceId: stripeInvoice.id,
            creditsGranted: plan.renewalCredits,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
          },
        },
      });

      this.logger.log(
        `Renewal credits granted: subscription=${subscription.id} +${plan.renewalCredits} credits`,
      );
    });
  }
}
