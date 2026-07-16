import Stripe from "stripe";
import {
  AddonPackage,
  BillingCycle,
  CreditGrantSourceType,
  CreditPolicy,
  PaymentProvider,
  Plan,
  PricingOption,
  Prisma,
  Product,
  ResetInterval,
  SubscriptionStatus,
  User,
} from "@prisma/client";
import { PrismaService } from "../../src/database/prisma.service";

export const rand = () => Math.random().toString(36).slice(2, 10);

type PlanWithPolicy = Plan & { creditPolicy: CreditPolicy };

/** Một nhánh catalog độc lập: Product → Plan (+CreditPolicy) → PricingOption. */
export interface CatalogTree {
  product: Product;
  plan: PlanWithPolicy;
  pricingOption: PricingOption;
}

export class TestContext {
  readonly runId = `${Date.now().toString(36)}${rand()}`;
  readonly prisma = new PrismaService();

  product!: Product;
  plan!: PlanWithPolicy;
  freePlan!: PlanWithPolicy;
  billingCycle!: BillingCycle;
  yearlyCycle!: BillingCycle;
  basicOption!: PricingOption;
  proOption!: PricingOption;
  freeOption!: PricingOption;
  addon!: AddonPackage;

  private readonly userIds: string[] = [];

  async seed(): Promise<void> {
    this.product = await this.prisma.product.create({
      data: {
        code: `TEST_PRODUCT_${this.runId}`,
        name: `Test Product ${this.runId}`,
      },
    });
    this.plan = await this.prisma.plan.create({
      data: {
        productId: this.product.id,
        code: `TEST_${this.runId}`,
        name: `Test Plan ${this.runId}`,
        creditPolicy: {
          create: { creditAmount: 100, resetInterval: ResetInterval.MONTHLY },
        },
      },
      include: { creditPolicy: true },
    }) as PlanWithPolicy;
    this.billingCycle = await this.prisma.billingCycle.create({
      data: { name: `test-monthly-${this.runId}`, durationDay: 30 },
    });
    this.yearlyCycle = await this.prisma.billingCycle.create({
      data: { name: `test-yearly-${this.runId}`, durationDay: 365 },
    });
    this.basicOption = await this.prisma.pricingOption.create({
      data: {
        planId: this.plan.id,
        productId: this.product.id,
        billingCycleId: this.billingCycle.id,
        name: `Test Basic ${this.runId}`,
        price: 10,
        currency: "usd",
        provider: PaymentProvider.STRIPE,
        providerPriceId: `price_test_basic_${this.runId}`,
      },
    });
    // Chu kỳ khác basicOption: `@@unique([planId, billingCycleId, currency, provider])`
    // từ chối hai SKU trùng nghĩa trên cùng một plan.
    this.proOption = await this.prisma.pricingOption.create({
      data: {
        planId: this.plan.id,
        productId: this.product.id,
        billingCycleId: this.yearlyCycle.id,
        name: `Test Pro ${this.runId}`,
        price: 20,
        currency: "usd",
        provider: PaymentProvider.STRIPE,
        providerPriceId: `price_test_pro_${this.runId}`,
      },
    });
    // Gói free dùng cho ca downgrade. Không cần code = "FREE" thật, vì
    // StripeService.getFreePriceId() được mock trong test.
    this.freePlan = await this.prisma.plan.create({
      data: {
        productId: this.product.id,
        code: `TEST_FREE_${this.runId}`,
        name: `Test Free Plan ${this.runId}`,
        isFree: true,
        creditPolicy: {
          create: { creditAmount: 50, resetInterval: ResetInterval.MONTHLY },
        },
      },
      include: { creditPolicy: true },
    }) as PlanWithPolicy;
    this.freeOption = await this.prisma.pricingOption.create({
      data: {
        planId: this.freePlan.id,
        productId: this.product.id,
        billingCycleId: this.billingCycle.id,
        name: `Test Free ${this.runId}`,
        price: 0,
        currency: "usd",
        provider: PaymentProvider.STRIPE,
        providerPriceId: `price_test_free_${this.runId}`,
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

  async createPaymentMethod(
    userId: string,
    overrides: Partial<Prisma.PaymentMethodUncheckedCreateInput> = {},
  ) {
    return this.prisma.paymentMethod.create({
      data: {
        userId,
        provider: PaymentProvider.STRIPE,
        providerPaymentMethodId: `pm_test_${rand()}`,
        brand: "visa",
        last4: "4242",
        expMonth: 12,
        expYear: new Date().getFullYear() + 2,
        fingerprint: `fp_test_${rand()}`,
        ...overrides,
      },
    });
  }

  /**
   * `productId` và `billingMode` truyền qua `overrides` như mọi cột khác.
   *
   * Lưu ý CHECK `Subscription_billing_mode_check`: `billingMode = 'NONE'` (row Free) hoặc
   * `MANUAL` bắt buộc `providerSubscriptionId: null`, nếu không DB từ chối. Mặc định ở đây
   * là PROVIDER + có providerSubscriptionId nên nhất quán sẵn.
   */
  async createSubscription(
    userId: string,
    overrides: Partial<Prisma.SubscriptionUncheckedCreateInput> = {},
  ) {
    return this.prisma.subscription.create({
      data: {
        userId,
        pricingOptionId: this.basicOption.id,
        productId: this.product.id,
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

  /**
   * Grant mặc định là ADDON: CHECK `CreditGrant_source_ref_check` bắt buộc
   * `sourceType = 'SUBSCRIPTION'` phải có `sourceRef` (id của sub sinh ra nó).
   *
   * `amountRemaining` mặc định bằng `amountGranted` (grant chưa tiêu).
   */
  async createGrant(
    userId: string,
    overrides: Partial<Prisma.CreditGrantUncheckedCreateInput> = {},
  ) {
    const amountGranted = overrides.amountGranted ?? 100;
    return this.prisma.creditGrant.create({
      data: {
        userId,
        productId: this.product.id,
        sourceType: CreditGrantSourceType.ADDON,
        amountGranted,
        amountRemaining: overrides.amountRemaining ?? amountGranted,
        ...overrides,
      },
    });
  }

  /**
   * Nhánh catalog thứ hai (product khác) để test đa product: consume theo chiều product,
   * "1 sub live per user PER PRODUCT", credit của product này không tiêu được cho product kia.
   *
   * Tạo lười — chỉ suite nào cần mới gọi, không bắt mọi suite trả giá seed.
   */
  async createCatalogTree(label: string): Promise<CatalogTree> {
    const suffix = `${label}_${this.runId}`;
    const product = await this.prisma.product.create({
      data: { code: `TEST_PRODUCT_${suffix}`, name: `Test Product ${suffix}` },
    });
    const plan = (await this.prisma.plan.create({
      data: {
        productId: product.id,
        code: `TEST_${suffix}`,
        name: `Test Plan ${suffix}`,
        creditPolicy: {
          create: { creditAmount: 100, resetInterval: ResetInterval.MONTHLY },
        },
      },
      include: { creditPolicy: true },
    })) as PlanWithPolicy;
    const pricingOption = await this.prisma.pricingOption.create({
      data: {
        planId: plan.id,
        productId: product.id,
        billingCycleId: this.billingCycle.id,
        name: `Test Option ${suffix}`,
        price: 10,
        currency: "usd",
        provider: PaymentProvider.STRIPE,
        providerPriceId: `price_test_${suffix}`,
      },
    });
    return { product, plan, pricingOption };
  }

  /**
   * Hai sub live cho cùng một user, trên hai product khác nhau — hình dạng mà
   * multi-subscription tồn tại để phục vụ.
   *
   * TODO(PR3 – Dev B): hiện NÉM. `Subscription.userId @unique` chặn sub thứ hai ở tầng DB
   * bất kể khác product. Sau khi B drop `@unique` (và `User.subscription` thành
   * `subscriptions[]`), helper này chạy được và partial unique index
   * `(userId, productId) WHERE status IN ('ACTIVE','PAST_DUE')` mới là thứ chặn — đúng
   * một sub live PER PRODUCT, không phải per user.
   */
  async createTwoProductSubs(userId: string, label = "second") {
    const tree = await this.createCatalogTree(label);
    const first = await this.createSubscription(userId);
    const second = await this.createSubscription(userId, {
      productId: tree.product.id,
      pricingOptionId: tree.pricingOption.id,
    });
    return { tree, first, second };
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
        // CreditTransaction.grantId → CreditGrant: con phải xoá trước cha.
        await prisma.creditTransaction.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.creditGrant.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.subscriptionEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
        await prisma.payment.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.invoice.deleteMany({ where: { subscriptionId: { in: subIds } } });
        await prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
        await prisma.creditWallet.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.paymentMethod.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
      await prisma.webhookEvent.deleteMany({ where: { id: { contains: this.runId } } });
      await prisma.pricingOption.deleteMany({
        where: { providerPriceId: { contains: this.runId } },
      });
      await prisma.billingCycle.deleteMany({ where: { name: { contains: this.runId } } });
      await prisma.creditPolicy.deleteMany({
        where: { plan: { code: { contains: this.runId } } },
      });
      await prisma.plan.deleteMany({ where: { code: { contains: this.runId } } });
      await prisma.product.deleteMany({ where: { code: { contains: this.runId } } });
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
          // mapInvoice đọc chu kỳ từ line, không phải top-level.
          period: { start: now, end: now + 30 * 86_400 },
        },
      ],
    },
    ...overrides,
  };
}

/**
 * Payload tối thiểu của Stripe.PaymentMethod.
 * Lưu ý: `payment_method.detached` gửi về customer = null.
 */
export function paymentMethodPayload(
  customerId: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `pm_test_${rand()}`,
    object: "payment_method",
    type: "card",
    customer: customerId,
    card: {
      brand: "visa",
      last4: "4242",
      exp_month: 12,
      exp_year: new Date().getFullYear() + 2,
      fingerprint: `fp_test_${rand()}`,
    },
    ...overrides,
  };
}

export function paymentIntentPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: `pi_test_${rand()}`,
    object: "payment_intent",
    amount: 1000,
    amount_received: 1000,
    currency: "usd",
    metadata: {},
    last_payment_error: { message: "Your card was declined." },
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
