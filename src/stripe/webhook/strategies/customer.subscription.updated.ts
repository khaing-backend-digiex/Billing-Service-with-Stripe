import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  SubscriptionStatus,
  SubscriptionEventType
} from "@prisma/client";

import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { SubscriptionSyncService } from "../../sync/subscription-sync.service";

const EVENT_TYPE = "customer.subscription.updated";

const STRIPE_STATUS = {
  UNPAID: "unpaid",
  CANCELED: "canceled",
} as const;

const CANCELLATION_REASON = {
  PAYMENT_FAILED: "payment_failed",
} as const;

import { StripeService } from "../../stripe.service";
import { CreditService } from "../../../credits/credit.service";
import { creditKey } from "../../../credits/credit.types";

@Injectable()
export class CustomerSubscriptionUpdatedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(CustomerSubscriptionUpdatedStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptionSyncService: SubscriptionSyncService,
    private readonly stripeService: StripeService,
    private readonly creditService: CreditService,
  ) { }

  canHandle(eventType: string): boolean {
    return eventType === EVENT_TYPE;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const stripeSubscription = event.data.object as Stripe.Subscription;

    this.logger.log(
      `${EVENT_TYPE}: ${stripeSubscription.id} -> ${stripeSubscription.status}`,
    );

    if (this.isPaymentFailure(stripeSubscription)) {
      await this.handlePaymentFailureExpiration(stripeSubscription);
      return;
    }
    await this.syncSubscription(stripeSubscription);
  }

  private isPaymentFailure(subscription: Stripe.Subscription): boolean {
    return (
      subscription.status === STRIPE_STATUS.UNPAID ||
      (subscription.status === STRIPE_STATUS.CANCELED &&
        subscription.cancellation_details?.reason === CANCELLATION_REASON.PAYMENT_FAILED)
    );
  }

  private async syncSubscription(stripeSubscription: Stripe.Subscription): Promise<void> {
    const existing = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: stripeSubscription.id },
    });

    if (existing && (existing.status === SubscriptionStatus.CANCELLED || existing.status === SubscriptionStatus.EXPIRED)) {
      this.logger.warn(
        `Subscription ${stripeSubscription.id} is already ${existing.status} locally. Ignoring updated webhook (out-of-order tolerance).`,
      );
      return;
    }

    const previousStatus = existing?.status;

    const paymentSubscription = this.stripeService.mapRawSubscription(stripeSubscription);
    const subscription = await this.subscriptionSyncService.syncFromStripe(paymentSubscription);

    if (!subscription) {
      this.logger.warn(`Cannot sync subscription ${stripeSubscription.id}`);
      return;
    }

    await this.handlePaymentRecovery(
      previousStatus,
      subscription.status,
      subscription.id,
      stripeSubscription.id,
    );
  }

  private async handlePaymentRecovery(
    previousStatus: SubscriptionStatus | undefined,
    currentStatus: SubscriptionStatus,
    subscriptionId: string,
    stripeSubscriptionId: string,
  ): Promise<void> {
    const recovered =
      previousStatus === SubscriptionStatus.PAST_DUE &&
      currentStatus === SubscriptionStatus.ACTIVE;

    if (!recovered) {
      return;
    }

    await this.prisma.subscriptionEvent.create({
      data: {
        subscriptionId,
        type: SubscriptionEventType.PAYMENT_RECOVERED,
        metadata: {
          stripeSubscriptionId,
        },
      },
    });

    this.logger.log(`Payment recovered: subscription ${subscriptionId} -> ACTIVE`);
  }

  private async handlePaymentFailureExpiration(stripeSubscription: Stripe.Subscription): Promise<void> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: stripeSubscription.id },
      include: { pricingOption: true },
    });

    if (!subscription) {
      this.logger.error(`No local subscription found for Stripe subscription ${stripeSubscription.id}`);
      return;
    }

    if (subscription.status !== SubscriptionStatus.EXPIRED) {
      await this.prisma.$transaction(async (tx) => {
        await tx.subscription.update({
          where: { id: subscription.id },
          data: {
            status: SubscriptionStatus.EXPIRED,
          },
        });

        await tx.subscriptionEvent.create({
          data: {
            subscriptionId: subscription.id,
            type: SubscriptionEventType.EXPIRED,
            metadata: {
              stripeSubscriptionId: stripeSubscription.id,
              stripeStatus: stripeSubscription.status,
              reason: CANCELLATION_REASON.PAYMENT_FAILED,
            },
          },
        });

        await this.creditService.revokeSubscriptionCredits(
          {
            userId: subscription.userId,
            productId: subscription.pricingOption.productId,
            description: "Credits forfeited – subscription expired (payment failed)",
            subscriptionId: subscription.id,
            idempotencyKey: creditKey.subscriptionRevoke(subscription.id, stripeSubscription.id),
          },
          tx,
        );
        
      });

      this.logger.log(
        `Subscription ${subscription.id} EXPIRED after exhausted payment retries (stripe status: ${stripeSubscription.status})`,
      );
    } else {
      this.logger.log(`Subscription ${subscription.id} already EXPIRED`);
    }
    await this.subscriptionSyncService.ensureFreePlanAfterTerminal(subscription);
  }
}
