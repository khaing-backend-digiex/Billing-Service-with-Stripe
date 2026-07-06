import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { Subscription, PricingOption, SubscriptionEventType } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { StripeService } from "../stripe.service";

type SubscriptionWithPricing = Subscription & { pricingOption: PricingOption };

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
    if (!freePriceId) return; 
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

    // Idempotent: đã có event DOWNGRADED cho subscription này thì skip
    // (tránh duplicate khi Stripe retry webhook)
    const existingDowngrade = await this.prisma.subscriptionEvent.findFirst({
      where: {
        subscriptionId: subscription.id,
        type: SubscriptionEventType.DOWNGRADED,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingDowngrade) {
      this.logger.log(`Subscription ${subscription.id} already has DOWNGRADED event — skipping`);
      return;
    }


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
