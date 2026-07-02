import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  PaymentProvider,
  PaymentStatus,
  CreditTransactionType,
  ReferenceType,
} from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";

/**
 * payment_intent.succeeded — một PaymentIntent đã thanh toán thành công.
 *
 * Handler này TỰ CHỨA (self-contained): nó tạo Payment + cấp credit Add-on hoàn toàn
 * dựa trên metadata của chính PaymentIntent, KHÔNG phụ thuộc vào checkout.session.completed
 * hay bất kỳ event nào khác — vì Stripe KHÔNG đảm bảo thứ tự giao webhook.
 *
 * Metadata (userId, addonPackageId) được đẩy xuống PI qua payment_intent_data khi tạo
 * Checkout session (xem StripeService.createCheckoutSession).
 *
 * Chỉ xử lý Add-on. Subscription credit (FREE/PRO) do invoice.paid lo.
 */
@Injectable()
export class PaymentIntentSucceededStrategy implements WebhookStrategy {
  private readonly logger = new Logger(PaymentIntentSucceededStrategy.name);

  constructor(private readonly prisma: PrismaService) {}

  private readonly paymentIntentSucceeded = "payment_intent.succeeded";
  canHandle(eventType: string): boolean {
    return eventType === this.paymentIntentSucceeded;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    this.logger.log(`payment_intent.succeeded: ${paymentIntent.id}`);

    const addonPackageId = paymentIntent.metadata?.addonPackageId;
    const userIdStr = paymentIntent.metadata?.userId;

    // Không phải Add-on (vd: PI của invoice subscription, hoặc bare PI) → bỏ qua.
    if (!addonPackageId || !userIdStr) {
      this.logger.log(`Intent ${paymentIntent.id} is not an addon purchase – skipping`);
      return;
    }

    const userId = parseInt(userIdStr, 10);
    if (Number.isNaN(userId)) {
      this.logger.error(`Invalid userId "${userIdStr}" in intent ${paymentIntent.id} metadata`);
      return;
    }

    // Idempotency: đã cấp credit rồi thì thôi (Stripe có thể gửi lại event).
    const existing = await this.prisma.payment.findUnique({
      where: { providerPaymentId: paymentIntent.id },
    });
    if (existing && existing.status === PaymentStatus.SUCCEEDED) {
      this.logger.log(`Payment for intent ${paymentIntent.id} already SUCCEEDED – skipping`);
      return;
    }

    const addon = await this.prisma.addonPackage.findUnique({
      where: { id: addonPackageId },
    });
    if (!addon) {
      this.logger.error(`Addon package ${addonPackageId} not found for intent ${paymentIntent.id}`);
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      // providerPaymentId là @unique → upsert vừa tạo mới, vừa idempotent khi retry.
      const payment = await tx.payment.upsert({
        where: { providerPaymentId: paymentIntent.id },
        create: {
          userId,
          addonPackageId,
          provider: PaymentProvider.STRIPE,
          providerPaymentId: paymentIntent.id,
          amount: addon.price,
          currency: addon.currency,
          status: PaymentStatus.SUCCEEDED,
          paidAt: new Date(),
        },
        update: { status: PaymentStatus.SUCCEEDED, paidAt: new Date() },
      });

      await tx.creditWallet.upsert({
        where: { userId },
        update: { addonCredits: { increment: addon.credits } },
        create: { userId, addonCredits: addon.credits },
      });

      await tx.creditTransaction.create({
        data: {
          userId,
          type: CreditTransactionType.ADDON_PURCHASE,
          amount: addon.credits,
          description: `Purchased Addon: ${addon.name}`,
          referenceType: ReferenceType.ADDON_PURCHASE,
          referenceId: payment.id,
        },
      });
    });

    this.logger.log(
      `✅ Addon credited: +${addon.credits} to user ${userId} (addon ${addon.code}, intent ${paymentIntent.id})`,
    );
  }
}
