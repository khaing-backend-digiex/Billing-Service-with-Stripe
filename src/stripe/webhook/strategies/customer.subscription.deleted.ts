import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { SubscriptionStatus, SubscriptionEventType } from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { FreePlanDowngradeService } from "../free-plan-downgrade.service";

@Injectable()
export class CustomerSubscriptionDeletedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(CustomerSubscriptionDeletedStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly freePlanDowngrade: FreePlanDowngradeService,
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

    // Idempotency: đã CANCELLED thì không tạo duplicate SubscriptionEvent,
    // nhưng vẫn chạy downgrade bên dưới để Stripe retry có thể hoàn tất
    // bước subscribe Free nếu lần xử lý trước fail giữa chừng.
    if (subscription.status !== SubscriptionStatus.CANCELLED) {
      await this.prisma.$transaction([
        this.prisma.subscription.update({
          where: { id: subscription.id },
          data: {
            status: SubscriptionStatus.CANCELLED,
            cancelledAt: new Date(),
            subscriptionCreditsRemaining: 0,
          },
        }),
        this.prisma.subscriptionEvent.create({
          data: {
            subscriptionId: subscription.id,
            type: SubscriptionEventType.CANCELLED,
            metadata: { stripeSubscriptionId: sub.id },
          },
        }),
      ]);

      this.logger.log(`Subscription ${subscription.id} cancelled`);
    } else {
      this.logger.log(`Subscription ${subscription.id} already CANCELLED`);
    }

    await this.freePlanDowngrade.downgradeToFree(
      subscription,
      sub,
      sub.cancellation_details?.reason ?? "subscription_deleted",
    );
  }
}
