import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { SubscriptionStatus, SubscriptionEventType } from "@prisma/client";
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

  private readonly customerSubcriptionUpdated = "customer.subscription.updated";
  canHandle(eventType: string): boolean {
    return eventType === this.customerSubcriptionUpdated;
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
      const subscription = await tx.subscription.findFirst({
        where: { providerSubscriptionId: sub.id },
      });

      if (!subscription) {
        this.logger.error(`No local subscription found for Stripe subscription ${sub.id}`);
        return;
      }

      const previousStatus = subscription.status;

      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status: newStatus,
          ...(sub.trial_end !== null && sub.trial_end !== undefined
            ? { trialEnd: new Date(sub.trial_end * 1000) }
            : {}),
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
