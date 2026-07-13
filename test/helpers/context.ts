import Stripe from "stripe";
import {
  AddonPackage,
  BillingCycle,
  PaymentProvider,
  Plan,
  PricingOption,
  Prisma,
  SubscriptionStatus,
  User,
} from "@prisma/client";
import { PrismaService } from "../../src/database/prisma.service";

export const rand = () => Math.random().toString(36).slice(2, 10);

/**
 * Bộ đồ nghề cho integration test chạy trên DB thật:
 * - seed Plan/BillingCycle/PricingOption/AddonPackage với id chứa runId duy nhất
 * - track mọi user tạo ra để cleanup() xoá sạch theo đúng thứ tự FK
 */
export class TestContext {
  readonly runId = `${Date.now().toString(36)}${rand()}`;
  readonly prisma = new PrismaService();

  plan!: Plan;
  billingCycle!: BillingCycle;
  basicOption!: PricingOption;
  proOption!: PricingOption;
  addon!: AddonPackage;

  private readonly userIds: number[] = [];

  async seed(): Promise<void> {
    this.plan = await this.prisma.plan.create({
      data: {
        code: `TEST_${this.runId}`,
        name: `Test Plan ${this.runId}`,
        renewalCredits: 100,
        resetIntervalDay: 30,
      },
    });
    this.billingCycle = await this.prisma.billingCycle.create({
      data: { name: `test-monthly-${this.runId}`, durationDay: 30 },
    });
    this.basicOption = await this.prisma.pricingOption.create({
      data: {
        planId: this.plan.id,
        billingCycleId: this.billingCycle.id,
        name: `Test Basic ${this.runId}`,
        price: 10,
        currency: "usd",
        provider: PaymentProvider.STRIPE,
        providerPriceId: `price_test_basic_${this.runId}`,
      },
    });
    this.proOption = await this.prisma.pricingOption.create({
      data: {
        planId: this.plan.id,
        billingCycleId: this.billingCycle.id,
        name: `Test Pro ${this.runId}`,
        price: 20,
        currency: "usd",
        provider: PaymentProvider.STRIPE,
        providerPriceId: `price_test_pro_${this.runId}`,
      },
    });
    this.addon = await this.prisma.addonPackage.create({
      data: {
        code: `TEST_ADDON_${this.runId}`,
        name: `Test Addon ${this.runId}`,
        credits: 50,
        price: 5,
        currency: "usd",
        provider: PaymentProvider.STRIPE,
        providerPriceId: `price_test_addon_${this.runId}`,
      },
    });
  }

  async createUser(): Promise<User> {
    const user = await this.prisma.user.create({
      data: {
        email: `test_${this.runId}_${rand()}@example.test`,
        roles: ["user"],
        provider: PaymentProvider.STRIPE,
        providerCustomerId: `cus_test_${rand()}`,
      },
    });
    this.userIds.push(user.id);
    return user;
  }

  async createSubscription(
    userId: number,
    overrides: Partial<Prisma.SubscriptionUncheckedCreateInput> = {},
  ) {
    return this.prisma.subscription.create({
      data: {
        userId,
        pricingOptionId: this.basicOption.id,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: new Date(Date.now() - 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 29 * 86_400_000),
        nextCreditResetAt: new Date(Date.now() + 29 * 86_400_000),
        subscriptionCreditsRemaining: 100,
        provider: PaymentProvider.STRIPE,
        providerSubscriptionId: `sub_test_${rand()}`,
        ...overrides,
      },
    });
  }

  async cleanup(): Promise<void> {
    const { prisma, userIds } = this;
    try {
      if (userIds.length > 0) {
        const subs = await prisma.subscription.findMany({
          where: { userId: { in: userIds } },
          select: { id: true },
        });
        const subIds = subs.map((s) => s.id);
        await prisma.creditTransaction.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.subscriptionEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
        await prisma.payment.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.invoice.deleteMany({ where: { subscriptionId: { in: subIds } } });
        await prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
        await prisma.creditWallet.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
      await prisma.webhookEvent.deleteMany({ where: { id: { contains: this.runId } } });
      await prisma.pricingOption.deleteMany({
        where: { providerPriceId: { contains: this.runId } },
      });
      await prisma.billingCycle.deleteMany({ where: { name: { contains: this.runId } } });
      await prisma.plan.deleteMany({ where: { code: { contains: this.runId } } });
      await prisma.addonPackage.deleteMany({ where: { code: { contains: this.runId } } });
    } finally {
      await prisma.$disconnect();
    }
  }
}

export function stripeEvent(type: string, object: unknown): Stripe.Event {
  return {
    id: `evt_test_${rand()}`,
    type,
    data: { object },
  } as unknown as Stripe.Event;
}

/**
 * Payload tối thiểu của Stripe.Invoice mà các strategy đọc tới.
 * Lưu ý: strategy lấy subscription id từ *line*, không phải field top-level.
 */
export function invoicePayload(
  stripeSubscriptionId: string | null,
  priceId: string,
  overrides: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `in_test_${rand()}`,
    customer: null as string | null,
    subscription: stripeSubscriptionId,
    status: "open",
    amount_due: 1000,
    amount_paid: 1000,
    currency: "usd",
    billing_reason: "subscription_cycle",
    attempt_count: 1,
    next_payment_attempt: null,
    due_date: null,
    period_start: now,
    period_end: now + 30 * 86_400,
    payment_intent: `pi_test_${rand()}`,
    lines: {
      data: [
        {
          type: "subscription",
          subscription: stripeSubscriptionId,
          price: { id: priceId },
          period: {
            start: now,
            end: now + 30 * 86_400,
          },
        },
      ],
    },
    ...overrides,
  };
}

/**
 * Payload tối thiểu của Stripe.Subscription mà các strategy đọc tới.
 * Lưu ý: chu kỳ nằm trong items.data[0], không phải top-level.
 */
export function subscriptionPayload(
  customerId: string,
  priceId: string,
  overrides: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `sub_test_${rand()}`,
    customer: customerId,
    status: "active",
    items: {
      data: [
        {
          price: { id: priceId },
          current_period_start: now,
          current_period_end: now + 30 * 86_400,
        },
      ],
    },
    trial_start: null,
    trial_end: null,
    cancel_at: null,
    canceled_at: null,
    cancel_at_period_end: false,
    cancellation_details: null,
    ...overrides,
  };
}
