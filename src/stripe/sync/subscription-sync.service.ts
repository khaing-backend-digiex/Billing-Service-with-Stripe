import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  Subscription,
  SubscriptionStatus,
  SubscriptionEventType,
  PaymentProvider,
  PricingOption,
} from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { PricingService } from "../../pricing/pricing.service";
import { PaymentSubscription } from "../../payments/types/payment.types";
import { StripeService } from "../stripe.service";
import { CreditService } from "../../credits/credit.service";
import { creditKey } from "../../credits/credit.types";
import { BillingMode } from "@prisma/client";
import { PERPETUAL_PERIOD_YEARS } from "../../common/constants/plan.constants";
import { addYears, fromUnixSeconds } from "../../common/utils/date.util";

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
    private readonly creditService: CreditService,
  ) { }

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

    const currentPeriodStart = fromUnixSeconds(sub.currentPeriodStart);
    const currentPeriodEnd = fromUnixSeconds(sub.currentPeriodEnd);

    const cancelledAt = sub.cancelAt ? fromUnixSeconds(sub.cancelAt) : null;

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
            cancelledAt,
            autoRenew: sub.cancelAtPeriodEnd === false,
          },
        });
      } else {
        if (!LIVE_STATUSES.includes(status)) {
          this.logger.warn(
            `Stripe subscription ${sub.id} is ${status} with no local row – ignoring (not materializing a non-live row).`,
          );
          return null;
        }

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
            cancelledAt,
            autoRenew: sub.cancelAtPeriodEnd === false,
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

  async provisionFreePlanFallback(userId: string, productId: string, tx?: any) {
    const doProvision = async (client: any) => {
      await client.user.update({
        where: { id: userId },
        data: { updatedAt: new Date() }
      });

      const freePlan = await client.plan.findFirst({
        where: { isFree: true, productId },
        include: { pricingOptions: true, creditPolicy: true },
      });
      const freeOption = freePlan?.pricingOptions?.[0];

      if (!freeOption) {
        this.logger.warn(`Could not provision free plan: no free option found for product ${productId}`);
        return;
      }

      const existingLive = await client.subscription.findFirst({
        where: {
          userId,
          productId,
          status: { in: LIVE_STATUSES },
        }
      });

      if (existingLive) {
        this.logger.log(`Live plan already exists for user ${userId}, skipping fallback provision`);
        return;
      }

      await client.subscription.create({
        data: {
          userId,
          productId,
          pricingOptionId: freeOption.id,
          status: SubscriptionStatus.ACTIVE,
          billingMode: BillingMode.NONE,
          currentPeriodStart: new Date(),
          currentPeriodEnd: addYears(new Date(), PERPETUAL_PERIOD_YEARS),
          nextCreditResetAt: new Date(),
        },
      });

      this.logger.log(`Provisioned new Free subscription for user ${userId} (fallback)`);
    };

    if (tx) {
      await doProvision(tx);
    } else {
      await this.prisma.$transaction(doProvision);
    }
  }

  async ensureFreePlanAfterTerminal(
    subscription: Subscription & { pricingOption: PricingOption },
  ): Promise<void> {
    const isFreePlan = Number(subscription.pricingOption?.price ?? 0) === 0;
    if (isFreePlan) {
      this.logger.log(
        `Terminal subscription ${subscription.id} was already Free – skipping free provision`,
      );
      return;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: subscription.userId },
      select: { id: true, providerCustomerId: true },
    });

    if (user?.providerCustomerId) {
      const stripeFreeSub = await this.stripeService.ensureFreeSubscription(
        user.providerCustomerId,
      );
      if (stripeFreeSub) {
        this.logger.log(
          `Created Stripe Free subscription for user ${user.id} – credits will be granted by invoice.paid`,
        );
        return;
      }
    }

    const productId = subscription.productId ?? subscription.pricingOption?.productId;
    if (productId) {
      this.logger.log(
        `Stripe unavailable – local Free fallback for user ${subscription.userId}`,
      );
      await this.provisionFreePlanFallback(subscription.userId, productId);
    }
  }
}
