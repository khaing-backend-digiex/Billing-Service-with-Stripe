import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { PaymentProvider, PaymentStatus } from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";

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

      const paymentIntentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent as any)?.id ?? null;

      await this.prisma.$transaction(async (tx) => {
        await tx.creditWallet.upsert({
          where: { userId },
          update: { addonCredits: { increment: addon.credits } },
          create: { userId, addonCredits: addon.credits },
        });

        await tx.creditTransaction.create({
          data: {
            userId,
            type: "ADDON_PURCHASE",
            amount: addon.credits,
            description: `Purchased Addon: ${addon.name}`,
            referenceType: "ADDON_PURCHASE",
            referenceId: session.id,
          },
        });

        if (paymentIntentId) {
          await tx.payment.upsert({
            where: { providerPaymentId: paymentIntentId },
            create: {
              userId,
              addonPackageId,
              provider: PaymentProvider.STRIPE,
              providerPaymentId: paymentIntentId,
              amount: addon.price,
              currency: addon.currency,
              status: PaymentStatus.SUCCEEDED,
              paidAt: new Date(),
            },
            update: {},
          });
        }
      });

      this.logger.log(`✅ Added ${addon.credits} addon credits to user ${userId}`);
    }
  }
}
