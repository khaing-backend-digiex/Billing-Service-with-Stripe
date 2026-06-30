import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { SubscriptionStatus, PaymentProvider } from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { PricingService } from "../../../pricing/pricing.service";

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
  private readonly logger = new Logger(
    CustomerSubscriptionCreatedStrategy.name,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
  ) {}

  private readonly customerSubscriptionCreated =
    "customer.subscription.created";
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

    const priceId = sub.items.data[0]?.price?.id;
    if (!priceId) {
      this.logger.error(`No price ID in subscription ${sub.id}`);
      return;
    }

    const pricingOption =
      await this.pricingService.findByProviderPriceId(priceId);
    if (!pricingOption) {
      this.logger.error(`No pricing option found for priceId ${priceId}`);
      return;
    }

    const status = STRIPE_STATUS_MAP[sub.status];
    if (!status) {
      this.logger.error(`Unknown Stripe subscription status: ${sub.status}`);
      return;
    }
    const currentPeriodStart = new Date(sub.current_period_start * 1000);
    const currentPeriodEnd = new Date(sub.current_period_end * 1000);

    const trialStart = sub.trial_start
      ? new Date(sub.trial_start * 1000)
      : null;
    const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;

    // credits = 0, sẽ được cấp đúng trong invoice.paid
    await this.prisma.subscription.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        pricingOptionId: pricingOption.id,
        status,
        currentPeriodStart,
        currentPeriodEnd,
        subscriptionCreditsRemaining: 0,
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
