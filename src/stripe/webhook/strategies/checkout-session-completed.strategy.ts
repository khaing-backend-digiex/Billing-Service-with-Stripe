import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { CreditTransactionType } from "@prisma/client";

@Injectable()
export class CheckoutSessionCompletedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(CheckoutSessionCompletedStrategy.name);

  constructor(private readonly prisma: PrismaService) {}
  private readonly checkoutSessionCompleted = "checkout.session.completed"
  canHandle(eventType: string): boolean {
    return eventType === this.checkoutSessionCompleted;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const session = event.data.object as Stripe.Checkout.Session;
    this.logger.log(`Checkout session completed: ${session.id}`);

    const addonPackageId = session.metadata?.addonPackageId;
    const userIdStr = session.metadata?.userId;

    if (addonPackageId && userIdStr) {
      const userId = parseInt(userIdStr, 10);
      if (isNaN(userId)) return;

      // Idempotency: kiểm tra CreditTransaction đã tồn tại cho session này chưa
      const existing = await this.prisma.creditTransaction.findFirst({
        where: { referenceId: session.id, referenceType: "ADDON_PURCHASE" },
      });

      if (existing) {
        this.logger.log(`Addon purchase ${session.id} already processed – skipping`);
        return;
      }

      const addon = await this.prisma.addonPackage.findUnique({ where: { id: addonPackageId } });
      if (!addon) return;

      await this.prisma.$transaction([
        this.prisma.creditWallet.upsert({
          where: { userId },
          update: { addonCredits: { increment: addon.credits } },
          create: { userId, addonCredits: addon.credits },
        }),
        this.prisma.creditTransaction.create({
          data: {
            userId,
            type: CreditTransactionType.ADDON_PURCHASE,
            amount: addon.credits,
            description: `Purchased Addon: ${addon.name}`,
            referenceType: CreditTransactionType.ADDON_PURCHASE,
            referenceId: session.id,
          },
        }),
      ]);

        this.logger.log(`Added ${addon.credits} addon credits to user ${userId}`);
      }
    }
}

