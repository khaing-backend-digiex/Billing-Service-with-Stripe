import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PaymentProvider, SubscriptionStatus, SubscriptionEventType, InvoiceStatus, CreditTransactionType, ReferenceType } from "@prisma/client";
import { PrismaService } from "@/database/prisma.service";
import { PricingService } from "@/pricing/pricing.service";
import { formatStripeAmountToDatabase } from "../../utils/stripe-currency.util";
import { addCalendarMonths } from "../../../common/utils/date.util";
import { PLAN_CODES } from "../../../common/constants/plan.constants";

import { StripeService } from "../../stripe.service";

@Injectable()
export class InvoicePaidStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaidStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
    private readonly stripeService: StripeService,
  ) { }

  private readonly invoicePaid = "invoice.paid";
  canHandle(eventType: string): boolean {
    return eventType === this.invoicePaid;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const rawInvoice = event.data.object;
    const paymentInvoice = this.stripeService.mapRawInvoice(rawInvoice);
    this.logger.log(`invoice.paid: ${paymentInvoice.id}`);

    const lineToUse = paymentInvoice.lines?.find(line => line.type === 'subscription') || paymentInvoice.lines?.[0];
    let stripeSubscriptionId = paymentInvoice.subscriptionId ?? lineToUse?.subscriptionId ?? null;

    if (!stripeSubscriptionId) {
      this.logger.error(`Invoice ${paymentInvoice.id} has no linked subscription, skipping`);
      return;
    }

    const userId = await this.prisma.user.findFirst({
      where: { providerCustomerId: paymentInvoice.customerId },
      select: { id: true },
    });

    if (!userId) {
      this.logger.error(`No user found for Stripe customer ${paymentInvoice.customerId}`);
      return;
    }

    let priceId = lineToUse?.priceId;

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
    const periodStart = new Date(paymentInvoice.periodStart * 1000);
    const periodEnd = new Date(paymentInvoice.periodEnd * 1000);
    const resetMonths = Math.max(1, Math.round(plan.resetIntervalDay / 30));
    const nextCreditResetAt = addCalendarMonths(periodStart, resetMonths);

    const isInitial = paymentInvoice.billingReason === "subscription_create";
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
      const invoice = await tx.invoice.upsert({
        where: { providerInvoiceId: paymentInvoice.id },
        create: {
          subscriptionId: subscription.id,
          provider: PaymentProvider.STRIPE,
          providerInvoiceId: paymentInvoice.id,
          amount: formatStripeAmountToDatabase(paymentInvoice.amountDue, paymentInvoice.currency),
          currency: paymentInvoice.currency,
          status: InvoiceStatus.PAID,
          dueAt: paymentInvoice.dueDate ? new Date(paymentInvoice.dueDate * 1000) : new Date(paymentInvoice.periodEnd * 1000),
        },
        update: {},
      });

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
      const creditWalletUpdateResult = await tx.creditWallet.updateMany({
        where: { userId: userId.id },
        data: {
          is_active: isActivePaid,
        },
      });

      if (creditWalletUpdateResult.count === 0) {
        this.logger.log(`No credit wallet found for user ${userId.id}, skipping wallet update`);
      }

      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          type: eventType,
          metadata: {
            stripeInvoiceId: paymentInvoice.id,
            creditsGranted: plan.renewalCredits,
            billingReason: paymentInvoice.billingReason,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
          },
        },
      });

      this.logger.log(
        `Credits granted: subscription=${subscription.id} +${plan.renewalCredits} (${plan.name}, ${paymentInvoice.billingReason})`,
      );
    })
  }
}
