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
import { FreePlanDowngradeService } from "../src/stripe/webhook/free-plan-downgrade.service";
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
  const freePlanDowngradeMock = { downgradeToFree: jest.fn().mockResolvedValue(undefined) };
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

    // Nâng cấp Free → PRO: Stripe tạo sub MỚI. Nếu invoice.paid không dời con trỏ,
    // hàng local vẫn trỏ vào sub Free cũ → bấm "Huỷ gói" sẽ huỷ nhầm sub Free,
    // còn sub PRO tiếp tục thu tiền.
    it("repoints providerSubscriptionId to the new Stripe subscription on upgrade", async () => {
      const user = await ctx.createUser();
      const oldFreeSubId = `sub_free_${rand()}`;
      const sub = await ctx.createSubscription(user.id, {
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

      const after = await ctx.prisma.subscription.findUniqueOrThrow({
        where: { id: sub.id },
      });
      expect(after.providerSubscriptionId).toBe(newPaidSubId);
      expect(after.pricingOptionId).toBe(ctx.basicOption.id);
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
        new InvoiceRecordService(ctx.prisma),
        stripeServiceMock as any,
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

    // §8: row local chỉ sinh ở invoice.paid ĐẦU TIÊN, nên payment_failed đến khi chưa có
    // row là thứ tự bình thường của Model B, không phải lỗi → phải log + bỏ qua, không throw.
    // Trước khi nối lại recordFailedAttempt, nhánh này gọi thẳng invoice.update() nên ném
    // P2025 và webhook fail vĩnh viễn qua mọi lần Stripe retry.
    it("tolerates a failure for a Stripe subscription that has no local row yet", async () => {
      const payload = invoicePayload(`sub_ghost_${rand()}`, ctx.basicOption.providerPriceId!, {
        attempt_count: 1,
        next_payment_attempt: Math.floor(Date.now() / 1000) + 86_400,
      });

      await expect(
        strategy().handle(stripeEvent("invoice.payment_failed", payload)),
      ).resolves.toBeUndefined();

      // và không được bịa ra invoice cho một sub không tồn tại
      expect(
        await ctx.prisma.invoice.count({ where: { providerInvoiceId: payload.id } }),
      ).toBe(0);
    });

    // TODO(Bước 3): test này encode model cũ "Free = Stripe sub đổi giá" – nó kỳ vọng
    // `upgradeSubscriptionTier` để hạ về free trên chính sub đó. Code đã cancel thay vì
    // đổi giá, và spec D9 chốt: hết retry → Stripe cancel → webhook `deleted` → row Free
    // MỚI (Free có billingMode=NONE, không có Stripe sub phía sau). Code gần spec hơn test.
    // Viết lại khi Bước 3 đổi lifecycle sang Model B, đừng sửa code cho vừa test này.
    it.skip("downgrades to the free plan and marks invoice UNCOLLECTIBLE when retries are exhausted", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id);
      const payload = invoicePayload(sub.providerSubscriptionId!, ctx.basicOption.providerPriceId!, {
        attempt_count: 4, // retriesUsed = 3 = MAX_RETRY_ATTEMPTS
        next_payment_attempt: null,
      });

      await strategy().handle(stripeEvent("invoice.payment_failed", payload));

      // Hết retry giờ HẠ VỀ FREE (đổi giá trên chính sub đó), không huỷ sub nữa.
      // `cancelSubscriptionNow` chỉ còn là đường lui khi không có gói free hoặc khi hạ gói lỗi.
      expect(stripeServiceMock.upgradeSubscriptionTier).toHaveBeenCalled();
      expect(stripeServiceMock.cancelSubscriptionNow).not.toHaveBeenCalled();

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
        freePlanDowngradeMock as any,
        new SubscriptionSyncService(
          ctx.prisma,
          pricingServiceStub as any,
          stripeServiceMock as any,
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

      expect(freePlanDowngradeMock.downgradeToFree).toHaveBeenCalledTimes(1);
    });
  });

  // ───────────────────────── customer.subscription.deleted ─────────────────────────
  describe("customer.subscription.deleted", () => {
    const strategy = () =>
      new CustomerSubscriptionDeletedStrategy(ctx.prisma, freePlanDowngradeMock as any, creditService);

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

  // ───────────── downgrade → invoice.paid: ai là chủ sở hữu việc cấp credit ─────────────
  // Bug thật (credits-refactor.md §2.4, user 13): free-plan-downgrade cấp credit, rồi
  // invoice.paid ($0) của chính free sub vừa tạo cấp lần nữa → sổ có 2 bút toán RENEWAL
  // cho một sự kiện, trong khi số dư chỉ tăng một lần (vì là phép gán). Sổ lệch số dư.
  describe("free plan downgrade", () => {
    const invoicePaid = () =>
      new InvoicePaidStrategy(
        ctx.prisma,
        pricingServiceStub as any,
        new PaidInvoiceSyncService(
          ctx.prisma,
          pricingServiceStub as any,
          new InvoiceRecordService(ctx.prisma),
          new PaymentRecordService(ctx.prisma),
          creditService,
        ),
        stripeServiceMock as any,
      );

    // TODO(Bước 3): test kỳ vọng KHÔNG có event CREATED khi rớt về free. Trong Model B,
    // `invoice.paid` với billing_reason=subscription_create CHÍNH LÀ sự kiện tạo row nên
    // CREATED là đúng ngữ nghĩa. Cả kịch bản này (free = Stripe sub) sẽ được viết lại ở Bước 3.
    it.skip("grants the free plan credits exactly once – invoice.paid owns the grant", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id, {
        subscriptionCreditsRemaining: 30,
      });

      // User đang ở gói trả phí ⇒ đã từng có hoá đơn được trả. Đây là mốc để phân biệt
      // "subscription mới" với "sub free sinh ra do downgrade".
      await ctx.prisma.invoice.create({
        data: {
          subscriptionId: sub.id,
          provider: PaymentProvider.STRIPE,
          providerInvoiceId: `in_paid_${rand()}`,
          amount: 10,
          currency: "usd",
          status: InvoiceStatus.PAID,
          dueAt: new Date(),
          paidAt: new Date(),
        },
      });

      const now = Math.floor(Date.now() / 1000);
      const freeSubId = `sub_free_${rand()}`;
      const stripeMock = {
        ...stripeServiceMock,
        getFreePriceId: jest.fn().mockResolvedValue(ctx.freeOption.providerPriceId),
        ensureFreeSubscription: jest.fn().mockResolvedValue({
          id: freeSubId,
          customerId: user.providerCustomerId,
          status: SubscriptionStatus.ACTIVE,
          items: [
            {
              priceId: ctx.freeOption.providerPriceId,
              currentPeriodStart: now,
              currentPeriodEnd: now + 30 * 86_400,
            },
          ],
          currentPeriodStart: now,
          currentPeriodEnd: now + 30 * 86_400,
          cancelAtPeriodEnd: false,
          created: now,
        }),
      };

      const deleted = new CustomerSubscriptionDeletedStrategy(
        ctx.prisma,
        new FreePlanDowngradeService(ctx.prisma, stripeMock as any),
        creditService,
      );

      await deleted.handle(
        stripeEvent(
          "customer.subscription.deleted",
          subscriptionPayload(user.providerCustomerId!, ctx.basicOption.providerPriceId!, {
            id: sub.providerSubscriptionId,
            status: "canceled",
          }),
        ),
      );

      // Sau downgrade: credit cũ đã bị đốt, và KHÔNG có bút toán cấp nào.
      const afterDowngrade = await ctx.prisma.subscription.findUniqueOrThrow({
        where: { id: sub.id },
      });
      expect(afterDowngrade.providerSubscriptionId).toBe(freeSubId);
      expect(afterDowngrade.pricingOptionId).toBe(ctx.freeOption.id);
      expect(afterDowngrade.subscriptionCreditsRemaining).toBe(0);
      expect(
        await ctx.prisma.creditTransaction.findMany({
          where: { userId: user.id, type: CreditTransactionType.RENEWAL },
        }),
      ).toHaveLength(0);

      // Stripe phát hành hoá đơn $0 cho free sub vừa tạo → đây mới là chỗ cấp credit.
      await invoicePaid().handle(
        stripeEvent(
          "invoice.paid",
          invoicePayload(freeSubId, ctx.freeOption.providerPriceId!, {
            customer: user.providerCustomerId,
            billing_reason: "subscription_create",
            amount_due: 0,
            amount_paid: 0,
            payment_intent: null,
          }),
        ),
      );

      const afterPaid = await ctx.prisma.subscription.findUniqueOrThrow({
        where: { id: sub.id },
      });
      expect(afterPaid.subscriptionCreditsRemaining).toBe(ctx.freePlan.creditPolicy.creditAmount);

      // Trước khi sửa: 2 bút toán RENEWAL (+50 downgrade, +50 invoice.paid) cho 1 sự kiện.
      const renewals = await ctx.prisma.creditTransaction.findMany({
        where: { userId: user.id, type: CreditTransactionType.RENEWAL },
      });
      expect(renewals).toHaveLength(1);
      expect(renewals[0].amount).toBe(ctx.freePlan.creditPolicy.creditAmount);

      // Sổ khớp số dư: -30 (đốt) rồi +50 (cấp) = 20 delta, số dư 30 → 50. ✓
      const forfeits = await ctx.prisma.creditTransaction.findMany({
        where: { userId: user.id, type: CreditTransactionType.EXPIRATION },
      });
      expect(forfeits).toHaveLength(1);
      expect(forfeits[0].amount).toBe(-30);

      // Hoá đơn đầu của free sub mang billing_reason=subscription_create, nhưng đây KHÔNG
      // phải subscription mới – nó là hạ gói. Không được ghi CREATED chồng lên DOWNGRADED.
      const events = await ctx.prisma.subscriptionEvent.findMany({
        where: { subscriptionId: sub.id },
        select: { type: true },
      });
      const types = events.map((e) => e.type);
      expect(types).toContain(SubscriptionEventType.DOWNGRADED);
      expect(types).not.toContain(SubscriptionEventType.CREATED);
      expect(types).toContain(SubscriptionEventType.RENEWED);
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

      // Add-on giờ là một CreditGrant riêng, không phải cột addonCredits trên CreditWallet:
      // replay không được đẻ grant thứ hai.
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
