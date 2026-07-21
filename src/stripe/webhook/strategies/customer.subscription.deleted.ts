import { Injectable, Logger, forwardRef, Inject } from "@nestjs/common";
import Stripe from "stripe";
import {
  SubscriptionStatus,
  SubscriptionEventType,
  BillingMode
} from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { CreditService } from "../../../credits/credit.service";
import { creditKey } from "../../../credits/credit.types";
import { SubscriptionSyncService } from "../../sync/subscription-sync.service";
import { StripeService } from "../../stripe.service";

@Injectable()
export class CustomerSubscriptionDeletedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(CustomerSubscriptionDeletedStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creditService: CreditService,
    private readonly subscriptionSyncService: SubscriptionSyncService,
    @Inject(forwardRef(() => StripeService))
    private readonly stripeService: StripeService,
  ) {}

  private readonly customerSubcriptionDeleted = "customer.subscription.deleted"
  canHandle(eventType: string): boolean {
    return eventType === this.customerSubcriptionDeleted;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const sub = event.data.object as Stripe.Subscription;
    this.logger.log(`customer.subscription.deleted: ${sub.id}`);

    const subscription = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: sub.id },
      include: { pricingOption: true },
    });

    if (!subscription) {
      this.logger.warn(`No local subscription found for Stripe subscription ${sub.id}. This is normal for abandoned checkouts.`);
      return;
    }

    if (subscription.status === SubscriptionStatus.EXPIRED) {
      this.logger.log(
        `Subscription ${subscription.id} is EXPIRED (superseded by a newer subscription) – ` +
        `ignoring deleted event for Stripe subscription ${sub.id}`,
      );
      return;
    }

    if (subscription.status !== SubscriptionStatus.CANCELLED) {
      await this.prisma.$transaction(async (tx) => {
        await tx.subscription.update({
          where: { id: subscription.id },
          data: {
            status: SubscriptionStatus.CANCELLED,
            cancelledAt: new Date(),
          },
        });

        await tx.subscriptionEvent.create({
          data: {
            subscriptionId: subscription.id,
            type: SubscriptionEventType.CANCELLED,
            metadata: { stripeSubscriptionId: sub.id },
          },
        });

        await this.creditService.revokeSubscriptionCredits(
          {
            userId: subscription.userId,
            productId: subscription.pricingOption.productId,
            description: `Subscription deleted: ${subscription.id}`,
            subscriptionId: subscription.id,
            idempotencyKey: creditKey.subscriptionRevoke(subscription.id, sub.id),
          },
          tx,
        );

      });

      this.logger.log(`Subscription ${subscription.id} cancelled`);
    } else {
      this.logger.log(`Subscription ${subscription.id} already CANCELLED`);
    }

    // Downgrade về Free dùng chung một đường với updated(unpaid): Stripe Free sub trước
    // (PROVIDER, credit qua invoice.paid), fallback row NONE local nếu Stripe fail.
    await this.subscriptionSyncService.ensureFreePlanAfterTerminal(subscription);
  }
}
