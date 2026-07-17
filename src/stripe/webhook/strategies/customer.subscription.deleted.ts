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

    // EXPIRED ≠ CANCELLED, và phân biệt được là điều kiện để không phá (§8).
    // EXPIRED = row bị một row live khác thay thế — chính invoice-paid đặt trạng thái này khi
    // user lên gói mới. Kịch bản thật: lên Pro → row Free thành EXPIRED → hủy sub Free trên
    // Stripe → Stripe phát `deleted` cho sub Free đó. Chạy tiếp là hỏng: revokeSubscriptionCredits
    // quét theo (userId, productId), KHÔNG theo subscriptionId, nên nó xóa luôn credit của row
    // Pro vừa cấp — user mất đúng số credit vừa trả tiền mua.
    if (subscription.status === SubscriptionStatus.EXPIRED) {
      this.logger.log(
        `Subscription ${subscription.id} is EXPIRED (superseded by a newer subscription) – ` +
        `ignoring deleted event for Stripe subscription ${sub.id}`,
      );
      return;
    }

    // CANCELLED thì khác: đây là replay của chính event này. Không ghi lại event/revoke lần
    // hai, nhưng vẫn đi tiếp xuống downgrade — lần trước có thể đã dựng Free thất bại.
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

    // Thay cho check chết ở bản cũ (`subscription.providerSubscriptionId !== sub.id` luôn
    // false vì `subscription` được tìm BẰNG `sub.id`). Ý đồ gốc vẫn đúng: nếu (user, product)
    // còn row live khác thì user không hề rớt về free — họ vừa chuyển sang gói khác. Dựng
    // Free lúc này sẽ đá vào partial unique index §13.1, và vì Free giờ có Stripe sub thật
    // (D2, sửa 2026-07-17) thì nó còn đẻ vòng lặp Free → cancel → Free.
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
