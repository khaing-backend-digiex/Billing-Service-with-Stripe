import {
  CreditTransactionType,
  InvoiceStatus,
  PaymentProvider,
  PaymentStatus,
  SubscriptionEventType,
  SubscriptionStatus,
} from "@prisma/client";
import { InvoiceCreatedStrategy } from "../src/stripe/webhook/strategies/invoice.created";
import { InvoicePaidStrategy } from "../src/stripe/webhook/strategies/invoice-paid.strategy";
import { InvoicePaymentFailedStrategy } from "../src/stripe/webhook/strategies/invoice.payment_failed";
import { CustomerSubscriptionCreatedStrategy } from "../src/stripe/webhook/strategies/customer.subscription.created";
import { CustomerSubscriptionUpdatedStrategy } from "../src/stripe/webhook/strategies/customer.subscription.updated";
import { CustomerSubscriptionDeletedStrategy } from "../src/stripe/webhook/strategies/customer.subscription.deleted";
import { CheckoutSessionCompletedStrategy } from "../src/stripe/webhook/strategies/checkout-session-completed.strategy";
import { PaymentIntentSucceededStrategy } from "../src/stripe/webhook/strategies/payment-intent-succeeded.strategy";
import { TestContext, invoicePayload, rand, stripeEvent, subscriptionPayload } from "./helpers/context";

describe("Webhook strategies (real DB, Stripe mocked)", () => {
  const ctx = new TestContext();

  // Mọi call ra Stripe API đều mock — chỉ DB là thật.
  const stripeServiceMock = {
    cancelSubscriptionNow: jest.fn().mockResolvedValue(undefined),
    getFreePriceId: jest.fn().mockResolvedValue(null),
    ensureFreeSubscription: jest.fn().mockResolvedValue(null),
  };
  const freePlanDowngradeMock = { downgradeToFree: jest.fn().mockResolvedValue(undefined) };
  // PricingService.findByProviderPriceId chỉ query DB → stub chạy query thật
  const pricingServiceStub = {
    findByProviderPriceId: (priceId: string) =>
      ctx.prisma.pricingOption.findFirst({
        where: { providerPriceId: priceId },
        include: { plan: true },
      }),
  };

  beforeAll(async () => {
    await ctx.seed();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ───────────────────────── invoice.created ─────────────────────────
  describe("invoice.created", () => {
    const strategy = () => new InvoiceCreatedStrategy(ctx.prisma);

    it("creates a local OPEN invoice for a known subscription", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id);
      const payload = invoicePayload(sub.providerSubscriptionId!, ctx.basicOption.providerPriceId!);

      await strategy().handle(stripeEvent("invoice.created", payload));

      const invoice = await ctx.prisma.invoice.findUnique({
        where: { providerInvoiceId: payload.id },
      });
      expect(invoice).not.toBeNull();
      expect(invoice!.status).toBe(InvoiceStatus.OPEN);
      expect(invoice!.subscriptionId).toBe(sub.id);
    });

    it("throws when the local subscription does not exist yet (so Stripe retries)", async () => {
      const payload = invoicePayload(`sub_missing_${rand()}`, ctx.basicOption.providerPriceId!);
      await expect(strategy().handle(stripeEvent("invoice.created", payload))).rejects.toThrow(
        /No local subscription/,
      );
    });

    it("skips when the invoice already exists (no duplicate)", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id);
      const payload = invoicePayload(sub.providerSubscriptionId!, ctx.basicOption.providerPriceId!);

      await strategy().handle(stripeEvent("invoice.created", payload));
      await strategy().handle(stripeEvent("invoice.created", payload));

      const count = await ctx.prisma.invoice.count({ where: { providerInvoiceId: payload.id } });
      expect(count).toBe(1);
    });
  });

  // ───────────────────────── invoice.paid ─────────────────────────
  describe("invoice.paid", () => {
    const strategy = () => new InvoicePaidStrategy(ctx.prisma, pricingServiceStub as any);

    it("marks invoice PAID, activates subscription, grants credits, records payment", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id, {
        status: SubscriptionStatus.PAST_DUE,
        subscriptionCreditsRemaining: 0,
      });
      const payload = invoicePayload(sub.providerSubscriptionId!, ctx.basicOption.providerPriceId!);
      await ctx.prisma.invoice.create({
        data: {
          subscriptionId: sub.id,
          provider: PaymentProvider.STRIPE,
          providerInvoiceId: payload.id,
          amount: 10,
          currency: "usd",
          status: InvoiceStatus.OPEN,
          dueAt: new Date(),
        },
      });

      await strategy().handle(stripeEvent("invoice.paid", payload));

      const invoice = await ctx.prisma.invoice.findUniqueOrThrow({
        where: { providerInvoiceId: payload.id },
      });
      expect(invoice.status).toBe(InvoiceStatus.PAID);
      expect(invoice.paidAt).not.toBeNull();

      const after = await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(after.status).toBe(SubscriptionStatus.ACTIVE);
      expect(after.subscriptionCreditsRemaining).toBe(ctx.plan.renewalCredits);

      const payment = await ctx.prisma.payment.findUnique({
        where: { providerPaymentId: payload.payment_intent as string },
      });
      expect(payment?.status).toBe(PaymentStatus.SUCCEEDED);

      const events = await ctx.prisma.subscriptionEvent.findMany({
        where: { subscriptionId: sub.id, type: SubscriptionEventType.RENEWED },
      });
      expect(events).toHaveLength(1);
    });

    it("upserts the invoice when invoice.paid arrives before invoice.created", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id, { subscriptionCreditsRemaining: 0 });
      const payload = invoicePayload(sub.providerSubscriptionId!, ctx.basicOption.providerPriceId!);

      await strategy().handle(stripeEvent("invoice.paid", payload));

      const invoice = await ctx.prisma.invoice.findUnique({
        where: { providerInvoiceId: payload.id },
      });
      expect(invoice).not.toBeNull();
      expect(invoice!.status).toBe(InvoiceStatus.PAID);

      const after = await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(after.subscriptionCreditsRemaining).toBe(ctx.plan.renewalCredits);
    });

    it("is idempotent: replaying the event does not double-grant credits", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id, { subscriptionCreditsRemaining: 0 });
      const payload = invoicePayload(sub.providerSubscriptionId!, ctx.basicOption.providerPriceId!);

      await strategy().handle(stripeEvent("invoice.paid", payload));
      await strategy().handle(stripeEvent("invoice.paid", payload));

      const txs = await ctx.prisma.creditTransaction.findMany({
        where: { userId: user.id, type: CreditTransactionType.RENEWAL },
      });
      expect(txs).toHaveLength(1);
    });

    it("throws when the local subscription does not exist yet (so Stripe retries)", async () => {
      const payload = invoicePayload(`sub_missing_${rand()}`, ctx.basicOption.providerPriceId!);
      await expect(strategy().handle(stripeEvent("invoice.paid", payload))).rejects.toThrow(
        /No local subscription/,
      );
    });
  });

  // ───────────────────────── invoice.payment_failed ─────────────────────────
  describe("invoice.payment_failed", () => {
    const strategy = () =>
      new InvoicePaymentFailedStrategy(ctx.prisma, stripeServiceMock as any);

    it("records retry info, FAILED payment, sets PAST_DUE; does not cancel on first failure", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id);
      const payload = invoicePayload(sub.providerSubscriptionId!, ctx.basicOption.providerPriceId!, {
        attempt_count: 1,
        next_payment_attempt: Math.floor(Date.now() / 1000) + 86_400,
      });

      await strategy().handle(stripeEvent("invoice.payment_failed", payload));

      const invoice = await ctx.prisma.invoice.findUniqueOrThrow({
        where: { providerInvoiceId: payload.id },
      });
      expect(invoice.status).toBe(InvoiceStatus.OPEN);
      expect(invoice.retryCount).toBe(1);
      expect(invoice.nextRetryAt).not.toBeNull();

      const after = await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(after.status).toBe(SubscriptionStatus.PAST_DUE);

      const payment = await ctx.prisma.payment.findUnique({
        where: { providerPaymentId: payload.payment_intent as string },
      });
      expect(payment?.status).toBe(PaymentStatus.FAILED);

      const events = await ctx.prisma.subscriptionEvent.findMany({
        where: { subscriptionId: sub.id, type: SubscriptionEventType.PAYMENT_FAILED },
      });
      expect(events).toHaveLength(1);
      expect(stripeServiceMock.cancelSubscriptionNow).not.toHaveBeenCalled();
    });

    it("cancels the Stripe subscription and marks invoice UNCOLLECTIBLE when retries are exhausted", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id);
      const payload = invoicePayload(sub.providerSubscriptionId!, ctx.basicOption.providerPriceId!, {
        attempt_count: 4, // retriesUsed = 3 = MAX_RETRY_ATTEMPTS
        next_payment_attempt: null,
      });

      await strategy().handle(stripeEvent("invoice.payment_failed", payload));

      expect(stripeServiceMock.cancelSubscriptionNow).toHaveBeenCalledWith(
        sub.providerSubscriptionId,
      );
      const invoice = await ctx.prisma.invoice.findUniqueOrThrow({
        where: { providerInvoiceId: payload.id },
      });
      expect(invoice.status).toBe(InvoiceStatus.UNCOLLECTIBLE);
      expect(invoice.nextRetryAt).toBeNull();
    });
  });

  // ───────────────────────── customer.subscription.created ─────────────────────────
  describe("customer.subscription.created", () => {
    const strategy = () =>
      new CustomerSubscriptionCreatedStrategy(
        ctx.prisma,
        pricingServiceStub as any,
        stripeServiceMock as any,
      );

    it("creates a local subscription with 0 credits (invoice.paid grants them)", async () => {
      const user = await ctx.createUser();
      const payload = subscriptionPayload(user.providerCustomerId!, ctx.basicOption.providerPriceId!);

      await strategy().handle(stripeEvent("customer.subscription.created", payload));

      const sub = await ctx.prisma.subscription.findUnique({ where: { userId: user.id } });
      expect(sub).not.toBeNull();
      expect(sub!.status).toBe(SubscriptionStatus.ACTIVE);
      expect(sub!.subscriptionCreditsRemaining).toBe(0);
      expect(sub!.providerSubscriptionId).toBe(payload.id);
    });

    it("on plan switch: repoints the local row, cancels the old Stripe sub, logs UPGRADED", async () => {
      const user = await ctx.createUser();
      const oldSub = await ctx.createSubscription(user.id, {
        pricingOptionId: ctx.basicOption.id,
      });
      const payload = subscriptionPayload(user.providerCustomerId!, ctx.proOption.providerPriceId!);

      await strategy().handle(stripeEvent("customer.subscription.created", payload));

      const sub = await ctx.prisma.subscription.findUniqueOrThrow({ where: { userId: user.id } });
      expect(sub.pricingOptionId).toBe(ctx.proOption.id);
      expect(sub.providerSubscriptionId).toBe(payload.id);
      expect(stripeServiceMock.cancelSubscriptionNow).toHaveBeenCalledWith(
        oldSub.providerSubscriptionId,
      );

      const events = await ctx.prisma.subscriptionEvent.findMany({
        where: { subscriptionId: sub.id, type: SubscriptionEventType.UPGRADED },
      });
      expect(events).toHaveLength(1);
    });
  });

  // ───────────────────────── customer.subscription.updated ─────────────────────────
  describe("customer.subscription.updated", () => {
    const strategy = () =>
      new CustomerSubscriptionUpdatedStrategy(ctx.prisma, freePlanDowngradeMock as any);

    it("PAST_DUE → active syncs status and logs PAYMENT_RECOVERED", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id, { status: SubscriptionStatus.PAST_DUE });
      const payload = subscriptionPayload(user.providerCustomerId!, ctx.basicOption.providerPriceId!, {
        id: sub.providerSubscriptionId,
        status: "active",
      });

      await strategy().handle(stripeEvent("customer.subscription.updated", payload));

      const after = await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(after.status).toBe(SubscriptionStatus.ACTIVE);

      const events = await ctx.prisma.subscriptionEvent.findMany({
        where: { subscriptionId: sub.id, type: SubscriptionEventType.PAYMENT_RECOVERED },
      });
      expect(events).toHaveLength(1);
    });

    it("status unpaid (final payment failure) → EXPIRED, credits forfeited, downgrade to Free triggered", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id, { subscriptionCreditsRemaining: 42 });
      const payload = subscriptionPayload(user.providerCustomerId!, ctx.basicOption.providerPriceId!, {
        id: sub.providerSubscriptionId,
        status: "unpaid",
      });

      await strategy().handle(stripeEvent("customer.subscription.updated", payload));

      const after = await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(after.status).toBe(SubscriptionStatus.EXPIRED);
      expect(after.subscriptionCreditsRemaining).toBe(0);

      const forfeits = await ctx.prisma.creditTransaction.findMany({
        where: { userId: user.id, type: CreditTransactionType.EXPIRATION },
      });
      expect(forfeits).toHaveLength(1);
      expect(forfeits[0].amount).toBe(-42);

      expect(freePlanDowngradeMock.downgradeToFree).toHaveBeenCalledTimes(1);
    });
  });

  // ───────────────────────── customer.subscription.deleted ─────────────────────────
  describe("customer.subscription.deleted", () => {
    const strategy = () =>
      new CustomerSubscriptionDeletedStrategy(ctx.prisma, freePlanDowngradeMock as any);

    it("cancels the local subscription, forfeits credits, triggers downgrade", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id, { subscriptionCreditsRemaining: 30 });
      const payload = subscriptionPayload(user.providerCustomerId!, ctx.basicOption.providerPriceId!, {
        id: sub.providerSubscriptionId,
        status: "canceled",
      });

      await strategy().handle(stripeEvent("customer.subscription.deleted", payload));

      const after = await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(after.status).toBe(SubscriptionStatus.CANCELLED);
      expect(after.subscriptionCreditsRemaining).toBe(0);
      expect(after.cancelledAt).not.toBeNull();

      const forfeits = await ctx.prisma.creditTransaction.findMany({
        where: { userId: user.id, type: CreditTransactionType.EXPIRATION },
      });
      expect(forfeits).toHaveLength(1);
      expect(forfeits[0].amount).toBe(-30);
      expect(freePlanDowngradeMock.downgradeToFree).toHaveBeenCalledTimes(1);
    });

    it("is idempotent on replay: no duplicate CANCELLED event, downgrade still re-attempted", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id);
      const payload = subscriptionPayload(user.providerCustomerId!, ctx.basicOption.providerPriceId!, {
        id: sub.providerSubscriptionId,
        status: "canceled",
      });

      await strategy().handle(stripeEvent("customer.subscription.deleted", payload));
      await strategy().handle(stripeEvent("customer.subscription.deleted", payload));

      const events = await ctx.prisma.subscriptionEvent.findMany({
        where: { subscriptionId: sub.id, type: SubscriptionEventType.CANCELLED },
      });
      expect(events).toHaveLength(1);
      expect(freePlanDowngradeMock.downgradeToFree).toHaveBeenCalledTimes(2);
    });
  });

  // ───────────────────────── checkout.session.completed ─────────────────────────
  describe("checkout.session.completed", () => {
    const strategy = () => new CheckoutSessionCompletedStrategy(ctx.prisma);

    it("records a PENDING addon payment and does not downgrade status on replay", async () => {
      const user = await ctx.createUser();
      const paymentIntentId = `pi_test_${rand()}`;
      const session = {
        id: `cs_test_${rand()}`,
        payment_intent: paymentIntentId,
        metadata: { addonPackageId: ctx.addon.id, userId: String(user.id) },
      };

      await strategy().handle(stripeEvent("checkout.session.completed", session));

      let payment = await ctx.prisma.payment.findUniqueOrThrow({
        where: { providerPaymentId: paymentIntentId },
      });
      expect(payment.status).toBe(PaymentStatus.PENDING);
      expect(payment.addonPackageId).toBe(ctx.addon.id);

      // Giả lập payment_intent.succeeded đã chạy trước, rồi session event bị replay
      await ctx.prisma.payment.update({
        where: { providerPaymentId: paymentIntentId },
        data: { status: PaymentStatus.SUCCEEDED },
      });
      await strategy().handle(stripeEvent("checkout.session.completed", session));

      payment = await ctx.prisma.payment.findUniqueOrThrow({
        where: { providerPaymentId: paymentIntentId },
      });
      expect(payment.status).toBe(PaymentStatus.SUCCEEDED); // không bị hạ về PENDING
    });
  });

  // ───────────────────────── payment_intent.succeeded ─────────────────────────
  describe("payment_intent.succeeded", () => {
    const strategy = () => new PaymentIntentSucceededStrategy(ctx.prisma);

    it("credits the addon wallet exactly once, even on replay", async () => {
      const user = await ctx.createUser();
      const intent = {
        id: `pi_test_${rand()}`,
        metadata: { addonPackageId: ctx.addon.id, userId: String(user.id) },
      };

      await strategy().handle(stripeEvent("payment_intent.succeeded", intent));
      await strategy().handle(stripeEvent("payment_intent.succeeded", intent));

      const wallet = await ctx.prisma.creditWallet.findUniqueOrThrow({
        where: { userId: user.id },
      });
      expect(wallet.addonCredits).toBe(ctx.addon.credits);

      const payment = await ctx.prisma.payment.findUniqueOrThrow({
        where: { providerPaymentId: intent.id },
      });
      expect(payment.status).toBe(PaymentStatus.SUCCEEDED);

      const txs = await ctx.prisma.creditTransaction.findMany({
        where: { userId: user.id, type: CreditTransactionType.ADDON_PURCHASE },
      });
      expect(txs).toHaveLength(1);
    });

    it("ignores payment intents without addon metadata (subscription PIs)", async () => {
      const intent = { id: `pi_test_${rand()}`, metadata: {} };
      await strategy().handle(stripeEvent("payment_intent.succeeded", intent));
      const payment = await ctx.prisma.payment.findUnique({
        where: { providerPaymentId: intent.id },
      });
      expect(payment).toBeNull();
    });
  });
});
