import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import {
  Subscription,
  PricingOption,
  SubscriptionEventType,
  SubscriptionStatus,
  PaymentProvider,
  BillingMode,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { StripeService } from "../stripe.service";
import { addCalendarMonths } from "../../common/utils/date.util";

type SubscriptionWithPricing = Subscription & { pricingOption: PricingOption };

const LIVE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.TRIALING,
];

const UNIQUE_VIOLATION = "P2002";

@Injectable()
export class FreePlanDowngradeService {
  private readonly logger = new Logger(FreePlanDowngradeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
  ) {}

  async downgradeToFree(
    subscription: SubscriptionWithPricing,
    stripeSub: Stripe.Subscription,
    reason: string,
  ): Promise<void> {
    const freePriceId = await this.stripeService.getFreePriceId();
    if (!freePriceId) return;
    if (subscription.pricingOption.providerPriceId === freePriceId) {
      this.logger.log(
        `Subscription ${subscription.id} is already the free plan – no downgrade`,
      );
      return;
    }

    const customerId =
      typeof stripeSub.customer === "string"
        ? stripeSub.customer
        : stripeSub.customer?.id;
    if (!customerId) {
      this.logger.error(
        `No customer on Stripe subscription ${stripeSub.id} – cannot downgrade`,
      );
      return;
    }

    // Model B (§8): row cũ đã terminal và BẤT BIẾN — không mutate nó nữa. Nếu (user, product)
    // đã có row live thì việc rớt free đã xong rồi (replay, hoặc cron/webhook chạy song song)
    // → không dựng thêm. Check này phải đứng TRƯỚC khi gọi Stripe: tạo sub rồi mới phát hiện
    // trùng thì đã đẻ ra một sub thừa phải đi hủy (§8).
    const existingLive = await this.prisma.subscription.findFirst({
      where: {
        userId: subscription.userId,
        productId: subscription.productId,
        status: { in: LIVE_STATUSES },
      },
      select: { id: true },
    });
    if (existingLive) {
      this.logger.log(
        `User ${subscription.userId} already has live subscription ${existingLive.id} for this ` +
        `product – no free downgrade needed for ${stripeSub.id}`,
      );
      return;
    }

    const freePricingOption = await this.prisma.pricingOption.findFirst({
      where: { providerPriceId: freePriceId },
      include: { plan: { include: { creditPolicy: true } } },
    });

    if (!freePricingOption) {
      this.logger.error(
        `No local pricing option for free price ${freePriceId} – cannot build the free row`,
      );
      return;
    }

    const freeSub = await this.stripeService.ensureFreeSubscription(customerId);
    if (!freeSub) return;

    const freeItem = freeSub.items[0];
    const periodStart = freeItem?.currentPeriodStart
      ? new Date(freeItem.currentPeriodStart * 1000)
      : new Date();
    const periodEnd = freeItem?.currentPeriodEnd
      ? new Date(freeItem.currentPeriodEnd * 1000)
      : addCalendarMonths(periodStart, 1);

    const freePlan = freePricingOption.plan as any;
    const resetMonths = freePlan.creditPolicy?.resetInterval === 'MONTHLY'
      ? 1
      : Math.max(1, Math.round((freePlan.creditPolicy?.intervalDays || 30) / 30));

    try {
      await this.prisma.$transaction(async (tx) => {
        // Row MỚI, không mutate row cũ (§8): row là contract instance, đã terminal thì bất
        // biến. Bản cũ ghi đè pricingOption + providerSubscriptionId của chính row Pro —
        // đó là "repoint" mà Model B xóa bỏ, và nó xóa luôn lịch sử: hợp đồng Pro biến mất,
        // Invoice/Payment của kỳ Pro treo vào một row giờ mang nhãn Free.
        const created = await tx.subscription.create({
          data: {
            userId: subscription.userId,
            productId: freePricingOption.productId,
            pricingOptionId: freePricingOption.id,
            status: SubscriptionStatus.ACTIVE,
            billingMode: BillingMode.PROVIDER,
            provider: PaymentProvider.STRIPE,
            providerSubscriptionId: freeSub.id,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            nextCreditResetAt: addCalendarMonths(periodStart, resetMonths),
          },
        });

        await tx.subscriptionEvent.create({
          data: {
            subscriptionId: created.id,
            type: SubscriptionEventType.DOWNGRADED,
            oldPricingOptionId: subscription.pricingOptionId,
            newPricingOptionId: freePricingOption.id,
            metadata: {
              stripeSubscriptionId: stripeSub.id,
              newStripeSubscriptionId: freeSub.id,
              previousSubscriptionId: subscription.id,
              reason,
            },
          },
        });

        this.logger.log(
          `User ${subscription.userId} downgraded to free: row ${created.id} ` +
          `(stripe sub ${freeSub.id}, reason: ${reason}) – credits will be granted by invoice.paid`,
        );
      });
    } catch (err) {
      // Thua race dựng row Free (partial unique index §13.1 chặn bản sao) → coi là SUCCESS,
      // không được fail webhook (§8). Nhưng Stripe sub vừa tạo giờ mồ côi: DB rollback được,
      // Stripe thì không. Phải hủy lại, nếu không đây đúng là loại zombie đang đi dọn.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === UNIQUE_VIOLATION
      ) {
        this.logger.log(
          `Free row for user ${subscription.userId} already created by another handler – ` +
          `cancelling the redundant Stripe subscription ${freeSub.id}`,
        );
        try {
          await this.stripeService.cancelSubscriptionNow(freeSub.id);
        } catch (cancelErr) {
          this.logger.error(
            `Failed to cancel redundant free Stripe subscription ${freeSub.id}: ` +
            `${cancelErr instanceof Error ? cancelErr.message : cancelErr}`,
          );
        }
        return;
      }
      throw err;
    }
  }
}
