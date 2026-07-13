import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PaymentService } from "../../payment.service";
import {
  STRIPE_METADATA_KEY,
  STRIPE_WEBHOOK_EVENT,
} from "../../../common/constants/stripe.constants";

/**
 * Thu tiền thất bại (thẻ bị từ chối, hết hạn, hết tiền...).
 *
 * Mặt đối xứng còn thiếu của `PaymentIntentSucceededStrategy`: trước đây không ai nghe event
 * này, nên hàng `Payment` nằm lại ở PENDING vĩnh viễn dù Stripe đã bỏ cuộc. Off-session làm
 * thất bại trở nên thường xuyên hơn nhiều.
 */
@Injectable()
export class PaymentIntentFailedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(PaymentIntentFailedStrategy.name);

  constructor(private readonly paymentService: PaymentService) {}

  canHandle(eventType: string): boolean {
    return eventType === STRIPE_WEBHOOK_EVENT.PAYMENT_INTENT_PAYMENT_FAILED;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    this.logger.warn(
      `payment_intent.payment_failed: ${paymentIntent.id} – ${paymentIntent.last_payment_error?.message ?? "unknown error"}`,
    );

    // Hàng đã tồn tại (kể cả PENDING mắc kẹt từ trước) → PaymentService lo, và chính nó chặn
    // việc hạ một khoản đã SUCCEEDED xuống FAILED.
    const existing = await this.paymentService.markFailed(paymentIntent.id);
    if (existing) return;

    const addonPackageId = paymentIntent.metadata?.[STRIPE_METADATA_KEY.ADDON_PACKAGE_ID];
    const userIdStr = paymentIntent.metadata?.[STRIPE_METADATA_KEY.USER_ID];

    // PI của subscription do Stripe tự tạo: `invoice.payment_failed` mới là nơi xử lý.
    // Không tạo hàng Payment mồ côi ở đây.
    if (!addonPackageId || !userIdStr) {
      this.logger.log(`Intent ${paymentIntent.id} is not an addon purchase – skipping`);
      return;
    }

    const userId = parseInt(userIdStr, 10);
    if (Number.isNaN(userId)) {
      this.logger.error(
        `Invalid userId "${userIdStr}" in intent ${paymentIntent.id} metadata`,
      );
      return;
    }

    // Addon mua off-session hỏng ngay lần đầu → chưa có hàng nào. Ghi lại để user thấy giao
    // dịch hỏng trong lịch sử thay vì nó biến mất không dấu vết.
    await this.paymentService.recordFailed({
      userId,
      providerPaymentId: paymentIntent.id,
      providerAmount: paymentIntent.amount,
      currency: paymentIntent.currency,
      addonPackageId,
    });

    this.logger.log(
      `Recorded FAILED addon payment for user ${userId} (intent ${paymentIntent.id})`,
    );
  }
}
