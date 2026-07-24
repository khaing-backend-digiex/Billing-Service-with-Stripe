import {
  CreditGrantSourceType,
  CreditTransactionType,
  InvoiceStatus,
  PaymentProvider,
  PaymentStatus,
  SubscriptionEventType,
  SubscriptionStatus,
  User,
} from "@prisma/client";
import { CreditService } from "../src/credits/credit.service";
import { CreditRepository } from "../src/credits/credit.repository";
import { InvoicePaidStrategy } from "../src/stripe/webhook/strategies/invoice-paid.strategy";
import { InvoicePaymentFailedStrategy } from "../src/stripe/webhook/strategies/invoice.payment_failed";
import { CustomerSubscriptionUpdatedStrategy } from "../src/stripe/webhook/strategies/customer.subscription.updated";
import { CustomerSubscriptionDeletedStrategy } from "../src/stripe/webhook/strategies/customer.subscription.deleted";
import { PaymentIntentSucceededStrategy } from "../src/stripe/webhook/strategies/payment-intent-succeeded.strategy";
import { PaidInvoiceSyncService } from "../src/stripe/sync/paid-invoice-sync.service";
import { InvoiceRecordService } from "../src/stripe/invoice-record.service";
import { PaymentRecordService } from "../src/stripe/payment-record.service";
import { SubscriptionSyncService } from "../src/stripe/sync/subscription-sync.service";
import { StripeAdapter } from "../src/stripe/adapter/stripe.adapter";
import { TestContext, invoicePayload, rand, stripeEvent, subscriptionPayload } from "./helpers/context";

describe("Webhook strategies (real DB, Stripe mocked)", () => {
  const ctx = new TestContext();

  // Adapter thật nhưng không gọi API: chỉ dùng các hàm map raw payload → domain type.
  const adapter = new StripeAdapter({ get: () => "sk_test_dummy" } as any);

  // Mọi call ra Stripe API đều mock — chỉ DB là thật.
  const stripeServiceMock = {
    cancelSubscriptionNow: jest.fn().mockResolvedValue(undefined),
    getFreePriceId: jest.fn().mockResolvedValue(null),
    ensureFreeSubscription: jest.fn().mockResolvedValue(null),
    upgradeSubscriptionTier: jest.fn().mockResolvedValue(undefined),
    mapRawInvoice: (raw: unknown) => adapter.mapRawInvoice(raw),
    mapRawSubscription: (raw: unknown) => adapter.mapRawSubscription(raw),
  };
  // PricingService.findByProviderPriceId chỉ query DB → stub chạy query thật
  const pricingServiceStub = {
    findByProviderPriceId: (priceId: string) =>
      ctx.prisma.pricingOption.findFirst({
        where: { providerPriceId: priceId },
        include: { plan: { include: { creditPolicy: true } } },
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

  const creditRepo = new CreditRepository(ctx.prisma);
  const creditService = new CreditService(ctx.prisma, creditRepo);

  // ───────────────────────── invoice.paid ─────────────────────────
  describe("invoice.paid", () => {
    const paidInvoiceSync = () =>
      new PaidInvoiceSyncService(
        ctx.prisma,
        pricingServiceStub as any,
        new InvoiceRecordService(ctx.prisma),
        new PaymentRecordService(ctx.prisma),
        creditService,
      );
    const strategy = () =>
      new InvoicePaidStrategy(
        ctx.prisma,
        pricingServiceStub as any,
        paidInvoiceSync(),
        stripeServiceMock as any,
      );

    const paidPayload = (user: User, stripeSubId: string | null) =>
      invoicePayload(stripeSubId, ctx.basicOption.providerPriceId!, {
        customer: user.providerCustomerId,
      });

    it("marks invoice PAID, activates subscription, grants credits, records payment", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id, {
        status: SubscriptionStatus.PAST_DUE,
      });
      const payload = paidPayload(user, sub.providerSubscriptionId!);
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
      expect(await ctx.subscriptionCredits(user.id)).toBe(
        ctx.plan.creditPolicy.creditAmount,
      );

      const payment = await ctx.prisma.payment.findUnique({
        where: { providerPaymentId: payload.payment_intent as string },
      });
      expect(payment?.status).toBe(PaymentStatus.SUCCEEDED);

      const events = await ctx.prisma.subscriptionEvent.findMany({
        where: { subscriptionId: sub.id, type: SubscriptionEventType.RENEWED },
      });
      expect(events).toHaveLength(1);
    });

    it("creates the local invoice when it does not exist yet", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id);
      const payload = paidPayload(user, sub.providerSubscriptionId!);

      await strategy().handle(stripeEvent("invoice.paid", payload));

      const invoice = await ctx.prisma.invoice.findUnique({
        where: { providerInvoiceId: payload.id },
      });
      expect(invoice).not.toBeNull();
      expect(invoice!.status).toBe(InvoiceStatus.PAID);

      expect(await ctx.subscriptionCredits(user.id)).toBe(
        ctx.plan.creditPolicy.creditAmount,
      );
    });

    it("creates the local subscription row when onboarding never produced one", async () => {
      const user = await ctx.createUser();
      const stripeSubId = `sub_test_${rand()}`;
      const payload = paidPayload(user, stripeSubId);

      await strategy().handle(stripeEvent("invoice.paid", payload));

      // findFirst chứ không findUnique: PR3 đã bỏ `Subscription.userId @unique`, một user
      // có thể có nhiều sub (mỗi product một cái).
      const sub = await ctx.prisma.subscription.findFirstOrThrow({
        where: { userId: user.id },
      });
      expect(sub.providerSubscriptionId).toBe(stripeSubId);
      expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
      expect(await ctx.subscriptionCredits(user.id)).toBe(
        ctx.plan.creditPolicy.creditAmount,
      );
    });

    it("is idempotent: replaying the event does not double-grant credits", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id);
      const payload = paidPayload(user, sub.providerSubscriptionId!);

      await strategy().handle(stripeEvent("invoice.paid", payload));
      await strategy().handle(stripeEvent("invoice.paid", payload));

      const txs = await ctx.prisma.creditTransaction.findMany({
        where: { userId: user.id, type: CreditTransactionType.RENEWAL },
      });
      expect(txs).toHaveLength(1);
      // Replay không được đẻ grant thứ hai – số dư là bằng chứng, không chỉ số bút toán.
      expect(await ctx.subscriptionCredits(user.id)).toBe(
        ctx.plan.creditPolicy.creditAmount,
      );
    });

    // Nâng cấp Free → PRO (Model B, §8/D3): Stripe tạo sub MỚI → invoice.paid tạo row Pro
    // MỚI map 1-1 với sub đó, row Free cũ chuyển EXPIRED và GIỮ NGUYÊN providerSubscriptionId
    // (bất biến theo Stripe sub). Không repoint/mutate row cũ — nhờ vậy huỷ gói huỷ đúng sub Pro.
    it("creates a new Pro row and expires the old Free row on upgrade (Model B)", async () => {
      const user = await ctx.createUser();
      const oldFreeSubId = `sub_free_${rand()}`;
      const freeRow = await ctx.createSubscription(user.id, {
        pricingOptionId: ctx.freeOption.id,
        providerSubscriptionId: oldFreeSubId,
        currentPeriodStart: new Date(Date.now() - 10 * 86_400_000),
      });

      const newPaidSubId = `sub_pro_${rand()}`;
      await strategy().handle(
        stripeEvent(
          "invoice.paid",
          invoicePayload(newPaidSubId, ctx.basicOption.providerPriceId!, {
            customer: user.providerCustomerId,
            billing_reason: "subscription_create",
          }),
        ),
      );

      // Row Free cũ: bất biến theo sub, chỉ chuyển terminal EXPIRED.
      const oldRow = await ctx.prisma.subscription.findUniqueOrThrow({
        where: { id: freeRow.id },
      });
      expect(oldRow.providerSubscriptionId).toBe(oldFreeSubId);
      expect(oldRow.status).toBe(SubscriptionStatus.EXPIRED);

      // Row Pro MỚI map 1-1 với Stripe sub mới.
      const proRow = await ctx.prisma.subscription.findFirstOrThrow({
        where: { providerSubscriptionId: newPaidSubId },
      });
      expect(proRow.id).not.toBe(freeRow.id);
      expect(proRow.status).toBe(SubscriptionStatus.ACTIVE);
      expect(proRow.pricingOptionId).toBe(ctx.basicOption.id);

      expect(await ctx.subscriptionCredits(user.id)).toBe(
        ctx.plan.creditPolicy.creditAmount,
      );
    });

    it("does not repoint when a stale invoice from an older period arrives late", async () => {
      const user = await ctx.createUser();
      const currentSubId = `sub_pro_${rand()}`;
      const sub = await ctx.createSubscription(user.id, {
        providerSubscriptionId: currentSubId,
        currentPeriodStart: new Date(),
      });

      const now = Math.floor(Date.now() / 1000);
      const oldPeriodStart = now - 60 * 86_400;
      const oldSubId = `sub_old_${rand()}`;

      await strategy().handle(
        stripeEvent(
          "invoice.paid",
          invoicePayload(oldSubId, ctx.basicOption.providerPriceId!, {
            customer: user.providerCustomerId,
            period_start: oldPeriodStart,
            period_end: oldPeriodStart + 30 * 86_400,
            lines: {
              data: [
                {
                  type: "subscription",
                  subscription: oldSubId,
                  price: { id: ctx.basicOption.providerPriceId },
                  period: { start: oldPeriodStart, end: oldPeriodStart + 30 * 86_400 },
                },
              ],
            },
          }),
        ),
      );

      const after = await ctx.prisma.subscription.findUniqueOrThrow({
        where: { id: sub.id },
      });
      expect(after.providerSubscriptionId).toBe(currentSubId);
    });

    // Bug thật: cron chữa trước (applyPaidInvoice), webhook retry tới sau.
    it("does not re-grant credits when the cron already applied the same invoice", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id);
      const payload = paidPayload(user, sub.providerSubscriptionId!);

      // Đường cron: reconcile gọi thẳng sync service với local subscription id.
      await paidInvoiceSync().applyPaidInvoice(adapter.mapRawInvoice(payload), sub.id);

      // User tiêu bớt credit trước khi webhook chậm chân tới nơi: trừ thẳng trên grant mà
      // cron vừa cấp, vì số dư giờ nằm ở đó.
      const granted = await ctx.prisma.creditGrant.findFirstOrThrow({
        where: { userId: user.id, sourceType: CreditGrantSourceType.SUBSCRIPTION_ALLOCATION },
      });
      await ctx.prisma.creditGrant.update({
        where: { id: granted.id },
        data: { amountRemaining: 10 },
      });

      await strategy().handle(stripeEvent("invoice.paid", payload));

      const txs = await ctx.prisma.creditTransaction.findMany({
        where: { userId: user.id, type: CreditTransactionType.RENEWAL },
      });
      expect(txs).toHaveLength(1);

      // Webhook tới sau không được cấp lại: số dư giữ nguyên 10 mà user đang có.
      expect(await ctx.subscriptionCredits(user.id)).toBe(10);
    });
  });

  // ───────────────────────── invoice.payment_failed ─────────────────────────
  describe("invoice.payment_failed", () => {
    const strategy = () =>
      new InvoicePaymentFailedStrategy(
        ctx.prisma,
        stripeServiceMock as any,
        creditService,
      );

    it("records retry info, sets PAST_DUE; does not cancel on first failure", async () => {
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

      const events = await ctx.prisma.subscriptionEvent.findMany({
        where: { subscriptionId: sub.id, type: SubscriptionEventType.PAYMENT_FAILED },
      });
      expect(events).toHaveLength(1);
      expect(stripeServiceMock.cancelSubscriptionNow).not.toHaveBeenCalled();
    });

    it("cancels the subscription and marks invoice UNCOLLECTIBLE when retries are exhausted", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id);
      const payload = invoicePayload(sub.providerSubscriptionId!, ctx.basicOption.providerPriceId!, {
        attempt_count: 4, // retriesUsed = 3 = MAX_RETRY_ATTEMPTS
        next_payment_attempt: null,
      });

      await strategy().handle(stripeEvent("invoice.payment_failed", payload));

      expect(stripeServiceMock.cancelSubscriptionNow).toHaveBeenCalled();
      expect(stripeServiceMock.upgradeSubscriptionTier).not.toHaveBeenCalled();

      const invoice = await ctx.prisma.invoice.findUniqueOrThrow({
        where: { providerInvoiceId: payload.id },
      });
      expect(invoice.status).toBe(InvoiceStatus.UNCOLLECTIBLE);
      expect(invoice.nextRetryAt).toBeNull();
    });
  });

  // ───────────────────────── customer.subscription.updated ─────────────────────────
  describe("customer.subscription.updated", () => {
    const strategy = () =>
      new CustomerSubscriptionUpdatedStrategy(
        ctx.prisma,
        new SubscriptionSyncService(
          ctx.prisma,
          pricingServiceStub as any,
          stripeServiceMock as any,
          creditService,
        ),
        stripeServiceMock as any,
        creditService,
      );

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
      const sub = await ctx.createSubscription(user.id);
      await ctx.createSubGrant(user.id, sub.id, 42);
      const payload = subscriptionPayload(user.providerCustomerId!, ctx.basicOption.providerPriceId!, {
        id: sub.providerSubscriptionId,
        status: "unpaid",
      });

      await strategy().handle(stripeEvent("customer.subscription.updated", payload));

      const after = await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(after.status).toBe(SubscriptionStatus.EXPIRED);
      expect(await ctx.subscriptionCredits(user.id)).toBe(0);

      const forfeits = await ctx.prisma.creditTransaction.findMany({
        where: { userId: user.id, type: CreditTransactionType.EXPIRATION },
      });
      expect(forfeits).toHaveLength(1);
      expect(forfeits[0].amount).toBe(-42);

      expect(stripeServiceMock.ensureFreeSubscription).toHaveBeenCalledTimes(1);
    });
  });

  // ───────────────────────── customer.subscription.deleted ─────────────────────────
  describe("customer.subscription.deleted", () => {
    const strategy = () =>
      new CustomerSubscriptionDeletedStrategy(
        ctx.prisma,
        creditService,
        new SubscriptionSyncService(
          ctx.prisma,
          pricingServiceStub as any,
          stripeServiceMock as any,
          creditService,
        ),
        stripeServiceMock as any,
      );

    it("cancels the local subscription, forfeits credits, triggers downgrade", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id);
      await ctx.createSubGrant(user.id, sub.id, 30);
      const payload = subscriptionPayload(user.providerCustomerId!, ctx.basicOption.providerPriceId!, {
        id: sub.providerSubscriptionId,
        status: "canceled",
      });

      await strategy().handle(stripeEvent("customer.subscription.deleted", payload));

      const after = await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(after.status).toBe(SubscriptionStatus.CANCELLED);
      expect(await ctx.subscriptionCredits(user.id)).toBe(0);
      expect(after.cancelledAt).not.toBeNull();

      const forfeits = await ctx.prisma.creditTransaction.findMany({
        where: { userId: user.id, type: CreditTransactionType.EXPIRATION },
      });
      expect(forfeits).toHaveLength(1);
      expect(forfeits[0].amount).toBe(-30);
      expect(stripeServiceMock.ensureFreeSubscription).toHaveBeenCalledTimes(1);
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
      expect(stripeServiceMock.ensureFreeSubscription).toHaveBeenCalledTimes(2);
    });
  });



  // ───────────────────────── payment_intent.succeeded ─────────────────────────
  describe("payment_intent.succeeded", () => {
    const strategy = () =>
      new PaymentIntentSucceededStrategy(
        ctx.prisma,
        new PaymentRecordService(ctx.prisma),
        creditService,
      );

    it("grants addon credits exactly once, even on replay", async () => {
      const user = await ctx.createUser();
      const intent = {
        id: `pi_test_${rand()}`,
        amount_received: 1000,
        currency: "usd",
        metadata: { addonPackageId: ctx.addon.id, userId: String(user.id) },
      };

      await strategy().handle(stripeEvent("payment_intent.succeeded", intent));
      await strategy().handle(stripeEvent("payment_intent.succeeded", intent));

      // Add-on là một CreditGrant riêng: replay không được đẻ grant thứ hai.
      const grants = await ctx.prisma.creditGrant.findMany({
        where: { userId: user.id, sourceType: CreditGrantSourceType.ADDON },
      });
      expect(grants).toHaveLength(1);
      expect(await ctx.remainingCredits(user.id, CreditGrantSourceType.ADDON)).toBe(
        ctx.addon.credits,
      );

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
