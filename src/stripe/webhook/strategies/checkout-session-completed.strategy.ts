import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { PaymentProvider, PaymentStatus } from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";

@Injectable()
export class CheckoutSessionCompletedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(CheckoutSessionCompletedStrategy.name);

  constructor(private readonly prisma: PrismaService) {}

  private readonly checkoutSessionCompleted = "checkout.session.completed";
  canHandle(eventType: string): boolean {
    return eventType === this.checkoutSessionCompleted;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const session = event.data.object as Stripe.Checkout.Session;
    this.logger.log(`checkout.session.completed: ${session.id}`);

    // Chỉ xử lý addon (one-time payment). Subscription credit do invoice.paid lo.
    const addonPackageId = session.metadata?.addonPackageId;
    const userIdStr = session.metadata?.userId;
    if (!addonPackageId || !userIdStr) {
      return; // không phải addon → bỏ qua
    }

    const userId = parseInt(userIdStr, 10);
    if (Number.isNaN(userId)) {
      this.logger.error(`Invalid userId "${userIdStr}" in session ${session.id} metadata`);
      return;
    }

    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? null;

    if (!paymentIntentId) {
      this.logger.error(`Session ${session.id} has no payment_intent, skipping`);
      return;
    }

    const addon = await this.prisma.addonPackage.findUnique({
      where: { id: addonPackageId },
    });
    if (!addon) {
      this.logger.error(`Addon package ${addonPackageId} not found`);
      return;
    }

    // Chỉ ghi nhận Payment ở trạng thái PENDING.
    // Credit addon sẽ được cấp khi payment_intent.succeeded xác nhận thanh toán thật sự.
    // Idempotency: providerPaymentId là @unique → upsert tránh tạo trùng khi Stripe retry.
    await this.prisma.payment.upsert({
      where: { providerPaymentId: paymentIntentId },
      create: {
        userId,
        addonPackageId,
        provider: PaymentProvider.STRIPE,
        providerPaymentId: paymentIntentId,
        amount: addon.price,
        currency: addon.currency,
        status: PaymentStatus.PENDING,
      },
      update: {}, // đã tồn tại → giữ nguyên, không downgrade trạng thái
    });

    this.logger.log(
      `Pending payment recorded: addon=${addon.code} user=${userId} intent=${paymentIntentId}`,
    );
  }
}
