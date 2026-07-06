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
import { StripeService } from "../stripe.service";

const LIVE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.PAST_DUE,
];

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
export class SubscriptionSyncService {
  private readonly logger = new Logger(SubscriptionSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
    private readonly stripeService: StripeService,
  ) {}


  async syncFromStripe(sub: Stripe.Subscription): Promise<Subscription | null> {
    const user = await this.prisma.user.findFirst({
      where: { providerCustomerId: sub.customer as string },
    });

    if (!user) {
      this.logger.error(`No user found for customer ${sub.customer}`);
      return null;
    }

    const price = sub.items.data[0]?.price;
    const priceId = typeof price === "string" ? price : price?.id;
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

    const status = STRIPE_STATUS_MAP[sub.status];
    if (!status) {
      this.logger.error(`Unknown Stripe subscription status: ${sub.status}`);
      return null;
    }
    const item = sub.items.data[0] as any;
    const currentPeriodStart = new Date(item.current_period_start * 1000);
    const currentPeriodEnd = new Date(item.current_period_end * 1000);

    const trialStart = sub.trial_start
      ? new Date(sub.trial_start * 1000)
      : null;
    const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;
    // Lấy từ Stripe thay vì hardcode null: khi user hẹn hủy cuối kỳ
    // (cancel_at_period_end) Stripe gửi updated với cancel_at set, status vẫn
    // active — mốc này cần được lưu lại chứ không xoá về null.
    const cancelledAt = sub.cancel_at ? new Date(sub.cancel_at * 1000) : null;

    const existing = await this.prisma.subscription.findUnique({
      where: { userId: user.id },
      include: { pricingOption: true },
    });


    const localSubscription = await this.prisma.$transaction(async (tx) => {
      const upserted = await tx.subscription.upsert({
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
          cancelledAt,
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
          cancelledAt,
        },
      });

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
