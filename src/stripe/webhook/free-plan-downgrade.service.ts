import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  Subscription,
  PricingOption,
  SubscriptionEventType,
  SubscriptionStatus,
} from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { StripeService } from "../stripe.service";
import { addCalendarMonths } from "../../common/utils/date.util";

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
      this.logger.log(
        `Subscription ${subscription.id} is already the free plan – no downgrade`,
      );
      return;
    }

    const customerId =
      typeof stripeSub.customer === "string"
        ? stripeSub.customer
        : stripeSub.customer?.id;
    if (!customerId) {
      this.logger.error(
        `No customer on Stripe subscription ${stripeSub.id} – cannot downgrade`,
      );
      return;
    }

    const currentRow = await this.prisma.subscription.findUnique({
      where: { id: subscription.id },
      select: { providerSubscriptionId: true },
    });
    if (currentRow?.providerSubscriptionId !== stripeSub.id) {
      this.logger.log(
        `Subscription ${subscription.id} now points to ${currentRow?.providerSubscriptionId} (not ${stripeSub.id}) – downgrade already handled, skipping`,
      );
      return;
    }

    const freeSub = await this.stripeService.ensureFreeSubscription(customerId);
    if (!freeSub) return;

    const freePricingOption = await this.prisma.pricingOption.findFirst({
      where: { providerPriceId: freePriceId },
      include: { plan: true },
    });

    const freeItem = freeSub.items[0];
    const periodStart = freeItem?.currentPeriodStart
      ? new Date(freeItem.currentPeriodStart * 1000)
      : new Date();
    const periodEnd = freeItem?.currentPeriodEnd
      ? new Date(freeItem.currentPeriodEnd * 1000)
      : addCalendarMonths(periodStart, 1);

    await this.prisma.$transaction(async (tx) => {
      if (freePricingOption) {
        const freePlan = freePricingOption.plan;
        const resetMonths = Math.max(
          1,
          Math.round(freePlan.resetIntervalDay / 30),
        );

        await tx.subscription.update({
          where: { id: subscription.id },
          data: {
            pricingOptionId: freePricingOption.id,
            status: SubscriptionStatus.ACTIVE,
            providerSubscriptionId: freeSub.id,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            nextCreditResetAt: addCalendarMonths(periodStart, resetMonths),
            cancelledAt: null,
          },
        });
      }

      await tx.subscriptionEvent.create({
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
    });

    this.logger.log(
      `User ${subscription.userId} downgraded to free plan (new stripe sub: ${freeSub.id}, reason: ${reason}) – credits will be granted by invoice.paid`,
    );
  }
}
