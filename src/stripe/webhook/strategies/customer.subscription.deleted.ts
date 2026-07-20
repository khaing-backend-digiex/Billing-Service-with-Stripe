import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  SubscriptionStatus,
  SubscriptionEventType,
  InvoiceStatus,
} from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { FreePlanDowngradeService } from "../free-plan-downgrade.service";
import { CreditService } from "../../../credits/credit.service";
import { creditKey } from "../../../credits/credit.types";

const LIVE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.TRIALING,
];
@Injectable()
export class CustomerSubscriptionDeletedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(CustomerSubscriptionDeletedStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly freePlanDowngrade: FreePlanDowngradeService,
    private readonly creditService: CreditService,
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
      this.logger.error(`No local subscription found for Stripe subscription ${sub.id}`);
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

    const otherLive = await this.prisma.subscription.findFirst({
      where: {
        userId: subscription.userId,
        productId: subscription.productId,
        id: { not: subscription.id },
        status: { in: LIVE_STATUSES },
      },
      select: { id: true },
    });

    if (otherLive) {
      this.logger.log(
        `Subscription ${subscription.id} superseded by live subscription ${otherLive.id} ` +
        `for the same product – skipping free downgrade`,
      );
      return;
    }

    const hasUnpaidInvoice = await this.prisma.invoice.findFirst({
      where: {
        subscriptionId: subscription.id,
        status: { in: [InvoiceStatus.OPEN, InvoiceStatus.UNCOLLECTIBLE] },
      },
    });

    if (hasUnpaidInvoice) {
      this.logger.warn(
        `Subscription ${subscription.id} cancelled with unpaid debt (invoice ${hasUnpaidInvoice.id}). Banning instead of downgrading to Free.`,
      );
      return;
    }

    await this.freePlanDowngrade.downgradeToFree(
      subscription,
      sub,
      sub.cancellation_details?.reason ?? "subscription_deleted",
    );
  }
}
