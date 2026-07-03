import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  SubscriptionStatus,
  SubscriptionEventType,
  CreditTransactionType,
  ReferenceType,
} from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { FreePlanDowngradeService } from "../free-plan-downgrade.service";

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
export class CustomerSubscriptionUpdatedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(CustomerSubscriptionUpdatedStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly freePlanDowngrade: FreePlanDowngradeService,
  ) { }

  private readonly customerSubscriptionUpdated = "customer.subscription.updated";
  canHandle(eventType: string): boolean {
    return eventType === this.customerSubscriptionUpdated;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const sub = event.data.object as Stripe.Subscription;
    this.logger.log(`customer.subscription.updated: ${sub.id} → ${sub.status}`);

    // Final failure: Smart Retries đã hết lượt → Stripe chuyển sang "unpaid"
    // hoặc cancel với reason "payment_failed" (tuỳ cấu hình Revenue recovery).
    // User tự cancel (reason "cancellation_requested") vẫn đi theo map CANCELLED bên dưới.
    const isFinalPaymentFailure =
      sub.status === "unpaid" ||
      (sub.status === "canceled" && sub.cancellation_details?.reason === "payment_failed");

    if (isFinalPaymentFailure) {
      await this.expireSubscription(sub);
      return;
    }

    const newStatus = STRIPE_STATUS_MAP[sub.status];
    if (!newStatus) {
      this.logger.error(`Unknown Stripe subscription status: "${sub.status}"`);
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      let subscription = await tx.subscription.findFirst({
        where: { providerSubscriptionId: sub.id },
        include: { pricingOption: true },
      });

      if (!subscription) {
        // Chờ 2 giây để nhường đường cho sự kiện created chạy xong (Race condition fix)
        this.logger.warn(`Subscription ${sub.id} not found, waiting 2s for created event...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        subscription = await tx.subscription.findFirst({
          where: { providerSubscriptionId: sub.id },
          include: { pricingOption: true },
        });
      }

      if (!subscription) {
        this.logger.error(`No local subscription found for Stripe subscription ${sub.id}`);
        throw new Error(`Race condition: subscription ${sub.id} not found yet.`);
      }

      const previousStatus = subscription.status;

      const currentPeriodStart = sub.current_period_start ? new Date(sub.current_period_start * 1000) : new Date();
      let currentPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      if (newStatus === SubscriptionStatus.CANCELLED && sub.canceled_at) {
        currentPeriodEnd = new Date(sub.canceled_at * 1000);
      }


      // Plan switch in-place (vd: đổi plan qua billing portal) → sync pricing
      // + ghi lịch sử UPGRADED/DOWNGRADED
      const stripePriceId = sub.items?.data[0]?.price?.id;
      let newPricingOptionId: string | undefined;
      if (stripePriceId && stripePriceId !== subscription.pricingOption.providerPriceId) {
        const newOption = await tx.pricingOption.findFirst({
          where: { providerPriceId: stripePriceId },
        });
        if (newOption) {
          newPricingOptionId = newOption.id;
          const isUpgrade = Number(newOption.price) > Number(subscription.pricingOption.price);
          await tx.subscriptionEvent.create({
            data: {
              subscriptionId: subscription.id,
              type: isUpgrade ? SubscriptionEventType.UPGRADED : SubscriptionEventType.DOWNGRADED,
              oldPricingOptionId: subscription.pricingOptionId,
              newPricingOptionId: newOption.id,
              metadata: { stripeSubscriptionId: sub.id },
            },
          });
          this.logger.log(
            `Plan ${isUpgrade ? "upgraded" : "downgraded"} in-place: ` +
              `${subscription.pricingOption.name} → ${newOption.name} (${sub.id})`,
          );
        } else {
          this.logger.error(`No pricing option found for priceId ${stripePriceId} – keeping old plan`);
        }
      }

      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status: newStatus,
          ...(newPricingOptionId ? { pricingOptionId: newPricingOptionId } : {}),
          ...(sub.trial_end !== null && sub.trial_end !== undefined
            ? { trialEnd: new Date(sub.trial_end * 1000) }
            : {}),
          cancelledAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
          currentPeriodStart: currentPeriodStart,
          currentPeriodEnd: currentPeriodEnd,
        },
      });

      if (previousStatus === SubscriptionStatus.PAST_DUE && newStatus === SubscriptionStatus.ACTIVE) {
        await tx.subscriptionEvent.create({
          data: {
            subscriptionId: subscription.id,
            type: SubscriptionEventType.PAYMENT_RECOVERED,
            metadata: { stripeSubscriptionId: sub.id },
          },
        });
        this.logger.log(`Payment recovered: subscription ${subscription.id} → ACTIVE`);
      }
    });
  }

  private async expireSubscription(sub: Stripe.Subscription): Promise<void> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: sub.id },
      include: { pricingOption: true },
    });

    if (!subscription) {
      this.logger.error(`No local subscription found for Stripe subscription ${sub.id}`);
      return;
    }

    // Idempotency: đã EXPIRED thì không tạo duplicate SubscriptionEvent,
    // nhưng vẫn chạy downgrade bên dưới để Stripe retry có thể hoàn tất
    // bước subscribe Free nếu lần xử lý trước fail giữa chừng.
    if (subscription.status !== SubscriptionStatus.EXPIRED) {
      await this.prisma.$transaction([
        this.prisma.subscription.update({
          where: { id: subscription.id },
          data: {
            status: SubscriptionStatus.EXPIRED,
            subscriptionCreditsRemaining: 0,
          },
        }),
        this.prisma.subscriptionEvent.create({
          data: {
            subscriptionId: subscription.id,
            type: SubscriptionEventType.EXPIRED,
            metadata: {
              stripeSubscriptionId: sub.id,
              stripeStatus: sub.status,
              reason: "payment_failed",
            },
          },
        }),
        // History phải đầy đủ: credit bị thu hồi cũng là 1 biến động số dư
        ...(subscription.subscriptionCreditsRemaining > 0
          ? [
              this.prisma.creditTransaction.create({
                data: {
                  userId: subscription.userId,
                  type: CreditTransactionType.EXPIRATION,
                  amount: -subscription.subscriptionCreditsRemaining,
                  description: "Credits forfeited – subscription expired (payment failed)",
                  referenceType: ReferenceType.SUBSCRIPTION,
                  referenceId: subscription.id,
                },
              }),
            ]
          : []),
      ]);

      this.logger.log(
        `Subscription ${subscription.id} EXPIRED after exhausted payment retries (stripe status: ${sub.status})`,
      );
    } else {
      this.logger.log(`Subscription ${subscription.id} already EXPIRED`);
    }

    await this.freePlanDowngrade.downgradeToFree(subscription, sub, "payment_failed");
  }
}
