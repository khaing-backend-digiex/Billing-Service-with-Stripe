import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";

@Injectable()
export class CheckoutSessionCompletedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(CheckoutSessionCompletedStrategy.name);

  constructor(private readonly prisma: PrismaService) {}

  canHandle(eventType: string): boolean {
    return eventType === "checkout.session.completed";
  }

  async handle(event: Stripe.Event): Promise<void> {
    const session = event.data.object as Stripe.Checkout.Session;
    this.logger.log(`Checkout session completed: ${session.id}`);

    const addonPackageId = session.metadata?.addonPackageId;
    const userIdStr = session.metadata?.userId;

    if (addonPackageId && userIdStr) {
      const userId = parseInt(userIdStr, 10);
      const addon = await this.prisma.addonPackage.findUnique({ where: { id: addonPackageId } });

      if (addon && !isNaN(userId)) {
        await this.prisma.creditWallet.upsert({
          where: { userId },
          update: { addonCredits: { increment: addon.credits } },
          create: { userId, addonCredits: addon.credits },
        });

        await this.prisma.creditTransaction.create({
          data: {
            userId,
            type: "ADDON_PURCHASE",
            amount: addon.credits,
            description: `Purchased Addon: ${addon.name}`,
            referenceType: "ADDON_PURCHASE",
            referenceId: session.id,
          }
        });

        this.logger.log(`✅ Added ${addon.credits} addon credits to user ${userId}`);
      }
    }
  }
}
