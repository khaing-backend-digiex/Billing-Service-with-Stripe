import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { Subscription, PricingOption, SubscriptionEventType } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { StripeService } from "../stripe.service";

type SubscriptionWithPricing = Subscription & { pricingOption: PricingOption };

/**
 * Tự động downgrade user về Free plan khi subscription trả phí kết thúc
 * (hết lượt retry payment → EXPIRED, hoặc user cancel → CANCELLED).
 *
 * Chỉ tạo free subscription phía Stripe + ghi SubscriptionEvent DOWNGRADED.
 * Việc sync record local và cấp 50 credits do flow webhook sẵn có lo:
 * customer.subscription.created (upsert subscription) → invoice.paid (cấp credit).
 */
@Injectable()
export class FreePlanDowngradeService {
  private readonly logger = new Logger(FreePlanDowngradeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
  ) {}

  async downgradeToFree(
    subscription: SubscriptionWithPricing,
    stripeSub: Stripe.Subscription,
    reason: string,
  ): Promise<void> {
    const freePriceId = await this.stripeService.getFreePriceId();
    if (!freePriceId) return; // ensureFreeSubscription sẽ warn, nhưng khỏi gọi Stripe vô ích

    // Subscription vừa kết thúc đã là Free plan → không downgrade (tránh loop resubscribe)
    if (subscription.pricingOption.providerPriceId === freePriceId) {
      this.logger.log(`Subscription ${subscription.id} is already the free plan – no downgrade`);
      return;
    }

    const customerId =
      typeof stripeSub.customer === "string" ? stripeSub.customer : stripeSub.customer?.id;
    if (!customerId) {
      this.logger.error(`No customer on Stripe subscription ${stripeSub.id} – cannot downgrade`);
      return;
    }

    // Idempotent: đã có free sub active thì trả về null → không ghi duplicate event.
    // Nếu Stripe call fail thì exception nổi lên → webhook không được đánh dấu
    // processed → Stripe retry và bước downgrade được chạy lại.
    const freeSub = await this.stripeService.ensureFreeSubscription(customerId);
    if (!freeSub) return;

    const freePricingOption = await this.prisma.pricingOption.findFirst({
      where: { providerPriceId: freePriceId },
    });

    await this.prisma.subscriptionEvent.create({
      data: {
        subscriptionId: subscription.id,
        type: SubscriptionEventType.DOWNGRADED,
        oldPricingOptionId: subscription.pricingOptionId,
        newPricingOptionId: freePricingOption?.id ?? null,
        metadata: {
          stripeSubscriptionId: stripeSub.id,
          newStripeSubscriptionId: freeSub.id,
          reason,
        },
      },
    });

    this.logger.log(
      `User ${subscription.userId} downgraded to free plan (new stripe sub: ${freeSub.id}, reason: ${reason})`,
    );
  }
}
