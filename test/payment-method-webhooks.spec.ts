import {
  InvoiceStatus,
  PaymentStatus,
  SubscriptionEventType,
  SubscriptionStatus,
} from "@prisma/client";
import { PaymentMethodStrategy } from "../src/stripe/webhook/strategies/payment-method.strategy";
import { SetupIntentStrategy } from "../src/stripe/webhook/strategies/setup-intent.strategy";
import { PaymentIntentFailedStrategy } from "../src/stripe/webhook/strategies/payment-intent-failed.strategy";
import { InvoicePaymentActionRequiredStrategy } from "../src/stripe/webhook/strategies/invoice-payment-action-required.strategy";
import { PaymentMethodSyncService } from "../src/stripe/sync/payment-method-sync.service";
import { InvoiceService } from "../src/stripe/invoice.service";
import { PaymentService } from "../src/stripe/payment.service";
import { StripeAdapter } from "../src/stripe/adapter/stripe.adapter";
import {
  TestContext,
  invoicePayload,
  paymentIntentPayload,
  paymentMethodPayload,
  rand,
  stripeEvent,
} from "./helpers/context";

describe("Payment method & off-session webhooks (real DB, Stripe mocked)", () => {
  const ctx = new TestContext();

  // Adapter thật nhưng không gọi API: chỉ dùng các hàm map raw payload → domain type.
  const adapter = new StripeAdapter({ get: () => "sk_test_dummy" } as any);

  // Thẻ mặc định mà "Stripe" đang giữ. Test tự đặt giá trị này để mô phỏng invoice_settings.
  let stripeDefaultPaymentMethodId: string | null = null;

  const stripeServiceMock = {
    getDefaultPaymentMethodId: jest.fn(async () => stripeDefaultPaymentMethodId),
    setDefaultPaymentMethod: jest.fn(async (_customerId: string, pmId: string) => {
      stripeDefaultPaymentMethodId = pmId;
    }),
    getPaymentMethod: jest.fn(),
    listPaymentMethods: jest.fn(async () => []),
    mapRawPaymentMethod: (raw: unknown) => adapter.mapRawPaymentMethod(raw),
    mapRawInvoice: (raw: unknown) => adapter.mapRawInvoice(raw),
  };

  const paymentMethodSync = () =>
    new PaymentMethodSyncService(ctx.prisma, stripeServiceMock as any);

  beforeAll(async () => {
    await ctx.seed();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    stripeDefaultPaymentMethodId = null;
  });

  // ───────────────────────── payment_method.* ─────────────────────────
  describe("payment_method.attached / .detached", () => {
    const strategy = () =>
      new PaymentMethodStrategy(stripeServiceMock as any, paymentMethodSync());

    it("attached: creates the local card with its display details", async () => {
      const user = await ctx.createUser();
      const payload = paymentMethodPayload(user.providerCustomerId!);

      await strategy().handle(stripeEvent("payment_method.attached", payload));

      const card = await ctx.prisma.paymentMethod.findUniqueOrThrow({
        where: { providerPaymentMethodId: payload.id },
      });
      expect(card.userId).toBe(user.id);
      expect(card.last4).toBe("4242");
      expect(card.brand).toBe("visa");
      // Stripe chưa đặt default → không thẻ nào được đánh dấu mặc định.
      expect(card.isDefault).toBe(false);
    });

    it("attached: marks the card default when Stripe says it is the default", async () => {
      const user = await ctx.createUser();
      const payload = paymentMethodPayload(user.providerCustomerId!);
      stripeDefaultPaymentMethodId = payload.id;

      await strategy().handle(stripeEvent("payment_method.attached", payload));

      const card = await ctx.prisma.paymentMethod.findUniqueOrThrow({
        where: { providerPaymentMethodId: payload.id },
      });
      expect(card.isDefault).toBe(true);
    });

    it("attached: is idempotent and keeps exactly one default across cards", async () => {
      const user = await ctx.createUser();
      const first = paymentMethodPayload(user.providerCustomerId!);
      const second = paymentMethodPayload(user.providerCustomerId!);

      stripeDefaultPaymentMethodId = first.id;
      await strategy().handle(stripeEvent("payment_method.attached", first));
      await strategy().handle(stripeEvent("payment_method.attached", first)); // replay

      stripeDefaultPaymentMethodId = second.id;
      await strategy().handle(stripeEvent("payment_method.attached", second));

      const cards = await ctx.prisma.paymentMethod.findMany({ where: { userId: user.id } });
      expect(cards).toHaveLength(2);
      expect(cards.filter((c) => c.isDefault)).toHaveLength(1);
      expect(cards.find((c) => c.isDefault)!.providerPaymentMethodId).toBe(second.id);
    });

    it("updated: refreshes the expiry that Stripe's card updater changed", async () => {
      const user = await ctx.createUser();
      const card = await ctx.createPaymentMethod(user.id, { expYear: 2030 });
      const payload = paymentMethodPayload(user.providerCustomerId!, {
        id: card.providerPaymentMethodId,
        card: { brand: "visa", last4: "9999", exp_month: 1, exp_year: 2035, fingerprint: "fp" },
      });

      await strategy().handle(stripeEvent("payment_method.updated", payload));

      const after = await ctx.prisma.paymentMethod.findUniqueOrThrow({
        where: { providerPaymentMethodId: card.providerPaymentMethodId },
      });
      expect(after.expYear).toBe(2035);
      expect(after.last4).toBe("9999");
    });

    it("detached: removes the local card even though the event carries no customer", async () => {
      const user = await ctx.createUser();
      const card = await ctx.createPaymentMethod(user.id, { isDefault: true });
      // Stripe gửi customer = null trong event này.
      const payload = paymentMethodPayload(null, { id: card.providerPaymentMethodId });

      await strategy().handle(stripeEvent("payment_method.detached", payload));

      const after = await ctx.prisma.paymentMethod.findUnique({
        where: { providerPaymentMethodId: card.providerPaymentMethodId },
      });
      expect(after).toBeNull();
    });
  });

  // ───────────────────────── setup_intent.* ─────────────────────────
  describe("setup_intent.succeeded / .setup_failed", () => {
    const strategy = () =>
      new SetupIntentStrategy(stripeServiceMock as any, paymentMethodSync());

    it("succeeded: saves the first card and makes it the default", async () => {
      const user = await ctx.createUser();
      const payload = paymentMethodPayload(user.providerCustomerId!);
      stripeServiceMock.getPaymentMethod.mockResolvedValue(
        adapter.mapRawPaymentMethod(payload) as never,
      );

      await strategy().handle(
        stripeEvent("setup_intent.succeeded", {
          id: `seti_test_${rand()}`,
          customer: user.providerCustomerId,
          payment_method: payload.id,
        }),
      );

      expect(stripeServiceMock.setDefaultPaymentMethod).toHaveBeenCalledWith(
        user.providerCustomerId,
        payload.id,
      );
      const card = await ctx.prisma.paymentMethod.findUniqueOrThrow({
        where: { providerPaymentMethodId: payload.id },
      });
      expect(card.isDefault).toBe(true);
    });

    it("succeeded: a second card does not silently steal the default", async () => {
      const user = await ctx.createUser();
      const existing = await ctx.createPaymentMethod(user.id, { isDefault: true });
      stripeDefaultPaymentMethodId = existing.providerPaymentMethodId;

      const payload = paymentMethodPayload(user.providerCustomerId!);
      stripeServiceMock.getPaymentMethod.mockResolvedValue(
        adapter.mapRawPaymentMethod(payload) as never,
      );

      await strategy().handle(
        stripeEvent("setup_intent.succeeded", {
          id: `seti_test_${rand()}`,
          customer: user.providerCustomerId,
          payment_method: payload.id,
        }),
      );

      expect(stripeServiceMock.setDefaultPaymentMethod).not.toHaveBeenCalled();
      const added = await ctx.prisma.paymentMethod.findUniqueOrThrow({
        where: { providerPaymentMethodId: payload.id },
      });
      expect(added.isDefault).toBe(false);
    });

    it("setup_failed: records nothing – the card was never attached", async () => {
      const user = await ctx.createUser();

      await strategy().handle(
        stripeEvent("setup_intent.setup_failed", {
          id: `seti_test_${rand()}`,
          customer: user.providerCustomerId,
          payment_method: null,
          last_setup_error: { message: "Your card was declined." },
        }),
      );

      const cards = await ctx.prisma.paymentMethod.findMany({ where: { userId: user.id } });
      expect(cards).toHaveLength(0);
    });
  });

  // ───────────────────────── payment_intent.payment_failed ─────────────────────────
  describe("payment_intent.payment_failed", () => {
    const strategy = () => new PaymentIntentFailedStrategy(new PaymentService(ctx.prisma));

    it("rescues a Payment stuck in PENDING", async () => {
      const user = await ctx.createUser();
      const payload = paymentIntentPayload({
        metadata: { userId: String(user.id), addonPackageId: ctx.addon.id },
      });
      await ctx.prisma.payment.create({
        data: {
          userId: user.id,
          addonPackageId: ctx.addon.id,
          provider: "STRIPE",
          providerPaymentId: payload.id,
          amount: 5,
          currency: "usd",
          status: PaymentStatus.PENDING,
        },
      });

      await strategy().handle(stripeEvent("payment_intent.payment_failed", payload));

      const payment = await ctx.prisma.payment.findUniqueOrThrow({
        where: { providerPaymentId: payload.id },
      });
      expect(payment.status).toBe(PaymentStatus.FAILED);
    });

    it("records a FAILED payment for an off-session addon that never got a local row", async () => {
      const user = await ctx.createUser();
      const payload = paymentIntentPayload({
        metadata: { userId: String(user.id), addonPackageId: ctx.addon.id },
      });

      await strategy().handle(stripeEvent("payment_intent.payment_failed", payload));

      const payment = await ctx.prisma.payment.findUniqueOrThrow({
        where: { providerPaymentId: payload.id },
      });
      expect(payment.status).toBe(PaymentStatus.FAILED);
      expect(payment.userId).toBe(user.id);
      // amount là cents từ Stripe → phải quy về đơn vị của DB.
      expect(Number(payment.amount)).toBe(10);

      // Thất bại thì không cấp credit.
      const wallet = await ctx.prisma.creditWallet.findUnique({ where: { userId: user.id } });
      expect(wallet).toBeNull();
    });

    it("never overwrites a payment that already SUCCEEDED", async () => {
      const user = await ctx.createUser();
      const payload = paymentIntentPayload({
        metadata: { userId: String(user.id), addonPackageId: ctx.addon.id },
      });
      await ctx.prisma.payment.create({
        data: {
          userId: user.id,
          addonPackageId: ctx.addon.id,
          provider: "STRIPE",
          providerPaymentId: payload.id,
          amount: 5,
          currency: "usd",
          status: PaymentStatus.SUCCEEDED,
          paidAt: new Date(),
        },
      });

      await strategy().handle(stripeEvent("payment_intent.payment_failed", payload));

      const payment = await ctx.prisma.payment.findUniqueOrThrow({
        where: { providerPaymentId: payload.id },
      });
      expect(payment.status).toBe(PaymentStatus.SUCCEEDED);
    });

    it("ignores subscription payment intents (invoice.payment_failed owns those)", async () => {
      const payload = paymentIntentPayload({ metadata: {} });

      await strategy().handle(stripeEvent("payment_intent.payment_failed", payload));

      const payment = await ctx.prisma.payment.findUnique({
        where: { providerPaymentId: payload.id },
      });
      expect(payment).toBeNull();
    });
  });

  // ───────────────────────── invoice.payment_action_required ─────────────────────────
  describe("invoice.payment_action_required", () => {
    const strategy = () =>
      new InvoicePaymentActionRequiredStrategy(
        ctx.prisma,
        new InvoiceService(ctx.prisma),
        stripeServiceMock as any,
      );

    it("first payment needing 3DS → INCOMPLETE, no credits granted", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id, {
        status: SubscriptionStatus.INCOMPLETE,
        subscriptionCreditsRemaining: 0,
      });
      const payload = invoicePayload(sub.providerSubscriptionId!, ctx.basicOption.providerPriceId!, {
        customer: user.providerCustomerId,
        billing_reason: "subscription_create",
      });

      await strategy().handle(stripeEvent("invoice.payment_action_required", payload));

      const after = await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(after.status).toBe(SubscriptionStatus.INCOMPLETE);
      expect(after.subscriptionCreditsRemaining).toBe(0);

      const invoice = await ctx.prisma.invoice.findUniqueOrThrow({
        where: { providerInvoiceId: payload.id },
      });
      expect(invoice.status).toBe(InvoiceStatus.OPEN);

      const events = await ctx.prisma.subscriptionEvent.findMany({
        where: { subscriptionId: sub.id, type: SubscriptionEventType.PAYMENT_ACTION_REQUIRED },
      });
      expect(events).toHaveLength(1);
    });

    it("renewal needing 3DS → PAST_DUE (the current plan is still live)", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id);
      const payload = invoicePayload(sub.providerSubscriptionId!, ctx.basicOption.providerPriceId!, {
        customer: user.providerCustomerId,
        billing_reason: "subscription_cycle",
      });

      await strategy().handle(stripeEvent("invoice.payment_action_required", payload));

      const after = await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(after.status).toBe(SubscriptionStatus.PAST_DUE);
    });
  });
});
