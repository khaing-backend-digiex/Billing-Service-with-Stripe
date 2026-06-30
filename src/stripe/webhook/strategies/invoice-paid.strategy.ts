import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { StripeService } from "../../stripe.service";
import { PricingService } from "../../../pricing/pricing.service";
import { PaymentProvider, SubscriptionStatus } from "@prisma/client";

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
      const stripeSub = await this.stripeService.getCustomer(invoice.customer as string);
      
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
      const currentPeriodEnd = new Date(lineItem.period.end * 1000);
      const currentPeriodStart = new Date(lineItem.period.start * 1000);

      // Add resetIntervalDay from plan
      const resetIntervalDay = pricingOption.plan.resetIntervalDay;
      const nextCreditResetAt = new Date();
      nextCreditResetAt.setDate(nextCreditResetAt.getDate() + resetIntervalDay);

      await this.prisma.subscription.upsert({
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
    }
  }
}
