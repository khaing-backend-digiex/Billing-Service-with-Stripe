import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { SubscriptionStatus, SubscriptionEventType, PaymentProvider } from "@prisma/client";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { PricingService } from "../../../pricing/pricing.service";
import { StripeService } from "../../stripe.service";

// Trạng thái "đang sống": plan switch từ các trạng thái này mới ghi event
// UPGRADED/DOWNGRADED. EXPIRED/CANCELLED → Free đã được FreePlanDowngradeService
// ghi DOWNGRADED rồi, không ghi trùng.
const LIVE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.PAST_DUE,
];

const STRIPE_STATUS_MAP: Record<string, SubscriptionStatus> = {
  active: SubscriptionStatus.ACTIVE,
  past_due: SubscriptionStatus.PAST_DUE,
  canceled: SubscriptionStatus.CANCELLED,
  unpaid: SubscriptionStatus.PAST_DUE,
  trialing: SubscriptionStatus.TRIALING,
  paused: SubscriptionStatus.PAUSED,
  incomplete: SubscriptionStatus.PAST_DUE,
  incomplete_expired: SubscriptionStatus.EXPIRED,
};

@Injectable()
export class CustomerSubscriptionCreatedStrategy implements WebhookStrategy {
  private readonly logger = new Logger(
    CustomerSubscriptionCreatedStrategy.name,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
    private readonly stripeService: StripeService,
  ) {}

  private readonly customerSubscriptionCreated =
    "customer.subscription.created";
  canHandle(eventType: string): boolean {
    return eventType === this.customerSubscriptionCreated;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const sub = event.data.object as Stripe.Subscription;
    this.logger.log(`customer.subscription.created: ${sub.id}`);

    const user = await this.prisma.user.findFirst({
      where: { providerCustomerId: sub.customer as string },
    });

    if (!user) {
      this.logger.error(`No user found for customer ${sub.customer}`);
      return;
    }

    const price = sub.items.data[0]?.price;
    const priceId = typeof price === 'string' ? price : price?.id;
    if (!priceId) {
      this.logger.error(`No price ID in subscription ${sub.id}`);
      return;
    }

    const pricingOption =
      await this.pricingService.findByProviderPriceId(priceId);
    if (!pricingOption) {
      this.logger.error(`No pricing option found for priceId ${priceId}`);
      return;
    }

    const status = STRIPE_STATUS_MAP[sub.status];
    if (!status) {
      this.logger.error(`Unknown Stripe subscription status: ${sub.status}`);
      return;
    }
    const currentPeriodStart = sub.current_period_start
      ? new Date(sub.current_period_start * 1000)
      : new Date();
    const currentPeriodEnd = sub.current_period_end
      ? new Date(sub.current_period_end * 1000)
      : new Date(currentPeriodStart.getTime() + 30 * 24 * 60 * 60 * 1000);

    const trialStart = sub.trial_start
      ? new Date(sub.trial_start * 1000)
      : null;
    const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;

    const existing = await this.prisma.subscription.findUnique({
      where: { userId: user.id },
      include: { pricingOption: true },
    });

    // credits = 0, sẽ được cấp đúng trong invoice.paid
    const localSubscription = await this.prisma.subscription.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        pricingOptionId: pricingOption.id,
        status,
        currentPeriodStart,
        currentPeriodEnd,
        subscriptionCreditsRemaining: 0,
        nextCreditResetAt: currentPeriodEnd,
        trialStart,
        trialEnd,
        provider: PaymentProvider.STRIPE,
        providerSubscriptionId: sub.id,
      },
      update: {
        pricingOptionId: pricingOption.id,
        status,
        currentPeriodStart,
        currentPeriodEnd,
        trialStart,
        trialEnd,
        providerSubscriptionId: sub.id,
        cancelledAt: null,
      },
    });

    // Business rule: mỗi user chỉ có 1 subscription active. Row local đã trỏ
    // sang sub mới (upsert ở trên) rồi mới hủy sub Stripe cũ — nhờ đó webhook
    // deleted của sub cũ không tìm thấy row local → không kích hoạt downgrade.
    if (
      existing &&
      existing.providerSubscriptionId &&
      existing.providerSubscriptionId !== sub.id
    ) {
      await this.stripeService.cancelSubscriptionNow(existing.providerSubscriptionId);
    }

    // Plan switch từ subscription đang sống → ghi lịch sử UPGRADED/DOWNGRADED
    if (
      existing &&
      existing.pricingOptionId !== pricingOption.id &&
      LIVE_STATUSES.includes(existing.status)
    ) {
      const isUpgrade = Number(pricingOption.price) > Number(existing.pricingOption.price);
      await this.prisma.subscriptionEvent.create({
        data: {
          subscriptionId: localSubscription.id,
          type: isUpgrade ? SubscriptionEventType.UPGRADED : SubscriptionEventType.DOWNGRADED,
          oldPricingOptionId: existing.pricingOptionId,
          newPricingOptionId: pricingOption.id,
          metadata: {
            oldStripeSubscriptionId: existing.providerSubscriptionId,
            newStripeSubscriptionId: sub.id,
          },
        },
      });
      this.logger.log(
        `Plan ${isUpgrade ? "upgraded" : "downgraded"} for user ${user.id}: ` +
          `${existing.pricingOption.name} → ${pricingOption.name}`,
      );
    }

    this.logger.log(`Subscription synced for user ${user.id} (${sub.id})`);
  }
}
