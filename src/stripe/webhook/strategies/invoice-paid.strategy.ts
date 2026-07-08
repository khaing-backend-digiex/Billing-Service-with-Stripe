import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PaidInvoiceSyncService } from "../../sync/paid-invoice-sync.service";
import {PaymentProvider, PaymentStatus, InvoiceStatus, SubscriptionStatus, CreditTransactionType, ReferenceType, SubscriptionEventType } from "@prisma/client";
import { PrismaService } from "@/database/prisma.service";
import { PricingService } from "@/pricing/pricing.service";
import { formatStripeAmountToDatabase } from "../../utils/stripe-currency.util";
import { addCalendarMonths } from "../../../common/utils/date.util";
import { PLAN_CODES } from "../../../common/constants/plan.constants";

@Injectable()
export class InvoicePaidStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaidStrategy.name);

  constructor(
    private readonly paidInvoiceSync: PaidInvoiceSyncService,
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
  ) { }

  private readonly invoicePaid = "invoice.paid";
  canHandle(eventType: string): boolean {
    return eventType === this.invoicePaid;
  }

  
  async handle(event: Stripe.Event): Promise<void> {
    const stripeInvoice = event.data.object as Stripe.Invoice;
    this.logger.log(`invoice.paid: ${stripeInvoice.id}`);
    
    const lineToUse = stripeInvoice.lines?.data?.find(line => line.type === 'subscription') || stripeInvoice.lines?.data?.[0];
    let stripeSubscriptionId = lineToUse?.subscription ?? (lineToUse as any)?.parent?.subscription_item_details?.subscription ?? null;

    if (!stripeSubscriptionId) {
      this.logger.error(`Invoice ${stripeInvoice.id} has no linked subscription, skipping`);
      return;
    }

    const userId = await this.prisma.user.findFirst({
      where: { providerCustomerId: stripeInvoice.customer as string },
      select: { id: true },
    });
    
    if (!userId) {
      this.logger.error(`No user found for Stripe customer ${stripeInvoice.customer}`);
      return;
    }

    let priceId = (lineToUse as any)?.pricing?.price_details?.price;

    if (!priceId) {
      this.logger.error(`No price ID found in invoice lines.`);
      return;
    }

    const pricingOption = await this.pricingService.findByProviderPriceId(priceId);
    if (!pricingOption) {
      this.logger.error(`No pricing option found for priceId ${priceId}`);
      return;
    }

    const plan = pricingOption.plan;
    const periodStart = new Date(stripeInvoice.period_start * 1000);
    const periodEnd = new Date(stripeInvoice.period_end * 1000);
    const resetMonths = Math.max(1, Math.round(plan.resetIntervalDay / 30));
    const nextCreditResetAt = addCalendarMonths(periodStart, resetMonths);

    const isInitial = stripeInvoice.billing_reason === "subscription_create";
    const eventType = isInitial ? SubscriptionEventType.CREATED : SubscriptionEventType.RENEWED;
    const description = isInitial
      ? `Credits granted ${plan.name} (initial)`
      : `Credits granted ${plan.name} (renewal)`;

    await this.prisma.$transaction(async (tx) => {
      const subscription = await tx.subscription.upsert({
        where: { userId: userId.id },
        create: {
          userId: userId.id,
          status: SubscriptionStatus.ACTIVE,
          pricingOptionId: pricingOption.id,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          subscriptionCreditsRemaining: plan.renewalCredits,
          nextCreditResetAt,
          provider: PaymentProvider.STRIPE,
          providerSubscriptionId: stripeSubscriptionId,
        },
        update: {
          status: SubscriptionStatus.ACTIVE,
          pricingOptionId: pricingOption.id,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          subscriptionCreditsRemaining: plan.renewalCredits,
          nextCreditResetAt,
        }
      });
      this.logger.log(
        `Subscription ${subscription.id} updated: status=ACTIVE, currentPeriodStart=${periodStart.toISOString()}, currentPeriodEnd=${periodEnd.toISOString()}, subscriptionCreditsRemaining=${plan.renewalCredits}, nextCreditResetAt=${nextCreditResetAt.toISOString()}`,
      );
      const invoice = await tx.invoice.create({
        data: {
          subscriptionId: subscription.id,
          provider: PaymentProvider.STRIPE,
          providerInvoiceId: stripeInvoice.id,
          amount: formatStripeAmountToDatabase(stripeInvoice.amount_due, stripeInvoice.currency),
          currency: stripeInvoice.currency,
          status: InvoiceStatus.PAID,
          dueAt: stripeInvoice.due_date ? new Date(stripeInvoice.due_date * 1000) : new Date(stripeInvoice.period_end * 1000),
        },
      });

      this.logger.log(
        `Invoice ${invoice.id} marked as PAID, subscription ${subscription.id} updated to ACTIVE, credits granted: +${plan.renewalCredits}`,
      );
      

      await tx.creditTransaction.create({
        data: {
          userId: subscription.userId,
          type: CreditTransactionType.RENEWAL,
          amount: plan.renewalCredits,
          description,
          referenceType: ReferenceType.SUBSCRIPTION,
          referenceId: subscription.id,
        },
      });

      const isActivePaid = plan.code !== PLAN_CODES.FREE;
      await tx.creditWallet.update({
        where: { userId: userId.id },
        data: {
          is_active: isActivePaid,
        },
      });

      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: eventType,
          metadata: {
            stripeInvoiceId: stripeInvoice.id,
            creditsGranted: plan.renewalCredits,
            billingReason: stripeInvoice.billing_reason,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
          },
        },
      });

      this.logger.log(
        `Credits granted: subscription=${subscription.id} +${plan.renewalCredits} (${plan.name}, ${stripeInvoice.billing_reason})`,
      );
    })
  }
}
