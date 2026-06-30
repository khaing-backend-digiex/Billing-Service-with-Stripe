import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { StripeService } from "../../stripe.service";
import { PricingService } from "../../../pricing/pricing.service";
import { PaymentProvider, SubscriptionStatus, InvoiceStatus, PaymentStatus } from "@prisma/client";
import { PLAN_CODES } from "../../../common/constants/plan.constants";

@Injectable()
export class InvoicePaidStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaidStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly pricingService: PricingService,
  ) {}

  canHandle(eventType: string): boolean {
    return eventType === "invoice.paid";
  }

  async handle(event: Stripe.Event): Promise<void> {
    const invoice = event.data.object as Stripe.Invoice;
    this.logger.log(`Invoice paid: ${invoice.id}`);
    
    if (invoice.subscription) {
      const subscriptionId = invoice.subscription as string;
      
      const lineItem = invoice.lines.data[0];
      const priceId = lineItem.price?.id;

      if (!priceId) return;

      const pricingOption = await this.pricingService.findByProviderPriceId(priceId);
      if (!pricingOption) {
        this.logger.error(`Pricing option not found for priceId ${priceId}`);
        return;
      }

      const user = await this.prisma.user.findFirst({
        where: { providerCustomerId: invoice.customer as string }
      });

      if (!user) {
        this.logger.error(`User not found for customer ${invoice.customer}`);
        return;
      }

      // Upsert Subscription in DB
      let currentPeriodEnd = new Date(lineItem.period.end * 1000);
      const currentPeriodStart = new Date(lineItem.period.start * 1000);

      if (pricingOption.plan.code === PLAN_CODES.FREE) {
        currentPeriodEnd.setFullYear(currentPeriodEnd.getFullYear() + 100);
      }

      // Add resetIntervalDay from plan
      const resetIntervalDay = pricingOption.plan.resetIntervalDay;
      const nextCreditResetAt = new Date();
      nextCreditResetAt.setDate(nextCreditResetAt.getDate() + resetIntervalDay);

      const dbSubscription = await this.prisma.subscription.upsert({
        where: { userId: user.id },
        update: {
          pricingOptionId: pricingOption.id,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart,
          currentPeriodEnd,
          subscriptionCreditsRemaining: pricingOption.plan.renewalCredits,
          nextCreditResetAt,
          providerSubscriptionId: subscriptionId,
        },
        create: {
          userId: user.id,
          pricingOptionId: pricingOption.id,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart,
          currentPeriodEnd,
          subscriptionCreditsRemaining: pricingOption.plan.renewalCredits,
          nextCreditResetAt,
          provider: PaymentProvider.STRIPE,
          providerSubscriptionId: subscriptionId,
        }
      });

      // Handle Invoice
      const amountPaid = invoice.amount_paid / 100;
      const paidAt = invoice.status_transitions?.paid_at 
        ? new Date(invoice.status_transitions.paid_at * 1000) 
        : new Date();
      const dueAt = new Date(invoice.created * 1000);

      let dbInvoice = await this.prisma.invoice.findFirst({
        where: { providerInvoiceId: invoice.id }
      });

      if (!dbInvoice) {
        dbInvoice = await this.prisma.invoice.create({
          data: {
            subscriptionId: dbSubscription.id,
            provider: PaymentProvider.STRIPE,
            providerInvoiceId: invoice.id,
            amount: amountPaid,
            currency: invoice.currency,
            status: InvoiceStatus.PAID,
            dueAt,
            paidAt,
          }
        });
      } else {
        dbInvoice = await this.prisma.invoice.update({
          where: { id: dbInvoice.id },
          data: {
            status: InvoiceStatus.PAID,
            paidAt,
          }
        });
      }

      // Handle Payment
      const paymentIntentId = invoice.payment_intent as string | null;
      if (paymentIntentId && amountPaid > 0) {
        await this.prisma.payment.upsert({
          where: { providerPaymentId: paymentIntentId },
          update: {
            status: PaymentStatus.SUCCEEDED,
            paidAt,
          },
          create: {
            userId: user.id,
            invoiceId: dbInvoice.id,
            provider: PaymentProvider.STRIPE,
            providerPaymentId: paymentIntentId,
            amount: amountPaid,
            currency: invoice.currency,
            status: PaymentStatus.SUCCEEDED,
            paidAt,
          }
        });
      }
    }
  }
}
