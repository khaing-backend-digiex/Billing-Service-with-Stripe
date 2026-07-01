import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { SubscriptionStatus, PaymentProvider } from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { PricingService } from "../../../pricing/pricing.service";
import { StripeService } from "../../stripe.service";
const STRIPE_STATUS_MAP: Record<string, SubscriptionStatus> = {
  active: SubscriptionStatus.ACTIVE,
  past_due: SubscriptionStatus.PAST_DUE,
  canceled: SubscriptionStatus.CANCELLED,
  unpaid: SubscriptionStatus.PAST_DUE,
  trialing: SubscriptionStatus.TRIALING,
  paused: SubscriptionStatus.PAUSED,
  incomplete: SubscriptionStatus.PAST_DUE,
  incomplete_expired: SubscriptionStatus.EXPIRED,
};

@Injectable()
export class CustomerSubscriptionCreatedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(CustomerSubscriptionCreatedStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
    private readonly stripeService: StripeService,
  ) {}

  private readonly customerSubscriptionCreated = "customer.subscription.created";
  canHandle(eventType: string): boolean {
    return eventType === this.customerSubscriptionCreated;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const sub = event.data.object as Stripe.Subscription;
    this.logger.log(`customer.subscription.created: ${sub.id}`);

    const user = await this.prisma.user.findFirst({
      where: { providerCustomerId: sub.customer as string },
    });

    if (!user) {
      this.logger.error(`No user found for customer ${sub.customer}`);
      return;
    }

    const price = sub.items.data[0]?.price;
    const priceId = typeof price === 'string' ? price : price?.id;
    if (!priceId) {
      this.logger.error(`No price ID in subscription ${sub.id}`);
      return;
    }

    const pricingOption = await this.pricingService.findByProviderPriceId(priceId);
    if (!pricingOption) {
      this.logger.error(`No pricing option found for priceId ${priceId}`);
      return;
    }

    const status = STRIPE_STATUS_MAP[sub.status];
    if(!status) {
      this.logger.error(`Unknown Stripe subscription status: ${sub.status}`);
      return;
    }
    const currentPeriodStart = sub.current_period_start
      ? new Date(sub.current_period_start * 1000)
      : new Date();
    const currentPeriodEnd = sub.current_period_end
      ? new Date(sub.current_period_end * 1000)
      : new Date(currentPeriodStart.getTime() + 30 * 24 * 60 * 60 * 1000);

    const trialStart = sub.trial_start ? new Date(sub.trial_start * 1000) : null;
    const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;

    // Check if user already has an active subscription with a different ID (meaning this is an upgrade)
    const existingSubscription = await this.prisma.subscription.findUnique({
      where: { userId: user.id },
    });

    if (
      existingSubscription && 
      existingSubscription.providerSubscriptionId && 
      existingSubscription.providerSubscriptionId !== sub.id
    ) {
      this.logger.log(`Cancelling old subscription ${existingSubscription.providerSubscriptionId} as new one ${sub.id} was created.`);
      await this.stripeService.cancelSubscription(existingSubscription.providerSubscriptionId);
    }

    // For FREE plans ($0), grant credits immediately to avoid webhook race conditions with invoice.paid
    const initialCredits = Number(pricingOption.price) === 0 ? pricingOption.plan.renewalCredits : 0;

    await this.prisma.subscription.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        pricingOptionId: pricingOption.id,
        status,
        currentPeriodStart,
        currentPeriodEnd,
        subscriptionCreditsRemaining: initialCredits,
        nextCreditResetAt: currentPeriodEnd,
        trialStart,
        trialEnd,
        provider: PaymentProvider.STRIPE,
        providerSubscriptionId: sub.id,
      },
      update: {
        pricingOptionId: pricingOption.id,
        status,
        currentPeriodStart,
        currentPeriodEnd,
        trialStart,
        trialEnd,
        providerSubscriptionId: sub.id,
        cancelledAt: null,
      },
    });

    this.logger.log(`Subscription synced for user ${user.id} (${sub.id})`);
  }
}
