import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  Subscription,
  SubscriptionStatus,
  SubscriptionEventType,
  PaymentProvider,
} from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { PricingService } from "../../pricing/pricing.service";
import { PaymentSubscription } from "../../payments/types/payment.types";
import { StripeService } from "../stripe.service";

const LIVE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.PAST_DUE,
];

@Injectable()
export class SubscriptionSyncService {
  private readonly logger = new Logger(SubscriptionSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
    private readonly stripeService: StripeService,
  ) {}

  async syncFromStripe(sub: PaymentSubscription): Promise<Subscription | null> {
    const user = await this.prisma.user.findFirst({
      where: { providerCustomerId: sub.customerId },
    });

    if (!user) {
      this.logger.error(`No user found for customer ${sub.customerId}`);
      return null;
    }

    const priceId = sub.items[0]?.priceId;
    if (!priceId) {
      this.logger.error(`No price ID in subscription ${sub.id}`);
      return null;
    }

    const pricingOption =
      await this.pricingService.findByProviderPriceId(priceId);
    if (!pricingOption) {
      this.logger.error(`No pricing option found for priceId ${priceId}`);
      return null;
    }

    const status = sub.status;

    const currentPeriodStart = new Date(sub.currentPeriodStart * 1000);
    const currentPeriodEnd = new Date(sub.currentPeriodEnd * 1000);

    const trialStart = sub.trialStart
      ? new Date(sub.trialStart * 1000)
      : null;
    const trialEnd = sub.trialEnd ? new Date(sub.trialEnd * 1000) : null;
    const cancelledAt = sub.cancelAt ? new Date(sub.cancelAt * 1000) : null;

    const existing = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: sub.id },
      include: { pricingOption: true },
    });

    const localSubscription = await this.prisma.$transaction(async (tx) => {
      let upserted;
      if (existing) {
        upserted = await tx.subscription.update({
          where: { id: existing.id },
          data: {
            pricingOptionId: pricingOption.id,
            status,
            currentPeriodStart,
            currentPeriodEnd,
            trialStart,
            trialEnd,
            cancelledAt,
            autoRenew: sub.cancelAtPeriodEnd === false,
          },
        });
      } else {
        // Expire any existing live subscription for this product
        await tx.subscription.updateMany({
          where: {
            userId: user.id,
            productId: pricingOption.plan.productId,
            status: { in: LIVE_STATUSES }
          },
          data: { status: SubscriptionStatus.EXPIRED }
        });

        upserted = await tx.subscription.create({
          data: {
            userId: user.id,
            productId: pricingOption.plan.productId,
            pricingOptionId: pricingOption.id,
            status,
            currentPeriodStart,
            currentPeriodEnd,
            nextCreditResetAt: currentPeriodEnd,
            trialStart,
            trialEnd,
            cancelledAt,
            provider: PaymentProvider.STRIPE,
            providerSubscriptionId: sub.id,
          },
        });
      }

      if (
        existing &&
        existing.pricingOptionId !== pricingOption.id &&
        LIVE_STATUSES.includes(existing.status)
      ) {
        const isUpgrade = Number(pricingOption.price) > Number(existing.pricingOption.price);
        await tx.subscriptionEvent.create({
          data: {
            subscriptionId: upserted.id,
            type: isUpgrade ? SubscriptionEventType.UPGRADED : SubscriptionEventType.DOWNGRADED,
            oldPricingOptionId: existing.pricingOptionId,
            newPricingOptionId: pricingOption.id,
            metadata: {
              oldStripeSubscriptionId: existing.providerSubscriptionId,
              newStripeSubscriptionId: sub.id,
            },
          },
        });
        this.logger.log(
          `Plan ${isUpgrade ? "upgraded" : "downgraded"} for user ${user.id}: ` +
            `${existing.pricingOption.name} → ${pricingOption.name}`,
        );
      }

      return upserted;
    });

    if (
      existing &&
      existing.providerSubscriptionId &&
      existing.providerSubscriptionId !== sub.id
    ) {
      await this.stripeService.cancelSubscriptionNow(existing.providerSubscriptionId);
    }

    this.logger.log(`Subscription synced for user ${user.id} (${sub.id})`);
    return localSubscription;
  }
}
