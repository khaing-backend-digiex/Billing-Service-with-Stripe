import {
  CreditGrantSourceType,
  CreditTransactionType,
  ReferenceType,
  SubscriptionStatus,
} from "@prisma/client";
import { FreePlanReconciliationCron } from "../src/cron/free-plan-reconciliation.cron";
import { PaidInvoiceSyncService } from "../src/stripe/sync/paid-invoice-sync.service";
import { InvoiceRecordService } from "../src/stripe/invoice-record.service";
import { PaymentRecordService } from "../src/stripe/payment-record.service";
import { StripeAdapter } from "../src/stripe/adapter/stripe.adapter";
import { CreditService } from "../src/credits/credit.service";
import { CreditRepository } from "../src/credits/credit.repository";
import { TestContext, invoicePayload, rand } from "./helpers/context";

describe("FreePlanReconciliationCron – missing settlement (real DB, Stripe mocked)", () => {
  const ctx = new TestContext();
  const adapter = new StripeAdapter({ get: () => "sk_test_dummy" } as any);

  const pricingServiceStub = {
    findByProviderPriceId: (priceId: string) =>
      ctx.prisma.pricingOption.findFirst({
        where: { providerPriceId: priceId },
        include: { plan: { include: { creditPolicy: true } } },
      }),
  };

  // Hoá đơn $0 mà Stripe đang giữ, tra theo stripe subscription id.
  const paidInvoices = new Map<string, ReturnType<typeof invoicePayload>>();

  const stripeMock = {
    getLatestPaidInvoice: jest.fn(async (stripeSubId: string) => {
      const payload = paidInvoices.get(stripeSubId);
      return payload ? adapter.mapRawInvoice(payload) : null;
    }),
    mapRawInvoice: (raw: unknown) => adapter.mapRawInvoice(raw),
  };

  // Pass onboarding không phải chủ đề ở đây – cho nó chạy rỗng.
  const usersMock = { findIncompleteOnboardingUsers: jest.fn(async () => []) };
  const subscriptionSyncMock = { syncFromStripe: jest.fn() };

  // CreditService thật, chạy trên DB thật – đây chính là thứ test muốn kiểm.
  const creditService = new CreditService(ctx.prisma, new CreditRepository(ctx.prisma));

  const cron = () =>
    new FreePlanReconciliationCron(
      stripeMock as any,
      usersMock as any,
      subscriptionSyncMock as any,
      new PaidInvoiceSyncService(
        ctx.prisma,
        pricingServiceStub as any,
        new InvoiceRecordService(ctx.prisma),
        new PaymentRecordService(ctx.prisma),
        creditService,
      ),
      ctx.prisma,
      creditService,
    );

  /** Sub đã quá grace: currentPeriodStart lùi về quá khứ. */
  const stalePeriodStart = new Date(Date.now() - 60 * 60_000);

  beforeAll(async () => {
    await ctx.seed();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    paidInvoices.clear();
  });

  it("settles a subscription whose invoice.paid never arrived", async () => {
    const user = await ctx.createUser();
    const freeSubId = `sub_free_${rand()}`;
    const sub = await ctx.createSubscription(user.id, {
      pricingOptionId: ctx.freeOption.id,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: stalePeriodStart,
      providerSubscriptionId: freeSubId,
    });

    paidInvoices.set(
      freeSubId,
      invoicePayload(freeSubId, ctx.freeOption.providerPriceId!, {
        customer: user.providerCustomerId,
        billing_reason: "subscription_create",
        amount_due: 0,
        amount_paid: 0,
        payment_intent: null,
      }),
    );

    await cron().reconcile();

    // Settle = cấp grant, không phải gán số lên cột chết.
    expect(await ctx.subscriptionCredits(user.id)).toBe(
      ctx.freePlan.creditPolicy.creditAmount,
    );
    const grants = await ctx.prisma.creditGrant.findMany({
      where: { userId: user.id, sourceType: CreditGrantSourceType.SUBSCRIPTION_ALLOCATION },
    });
    expect(grants).toHaveLength(1);
    // sourceRef = SUB, không phải hoá đơn. Đây là assert giữ cho reconcile đúng: chính cột
    // này là thứ NOT EXISTS của cron tìm. Ghi invoice.id vào đây thì sub settle qua
    // invoice.paid thành vô hình với cron và kẹt vĩnh viễn.
    expect(grants[0].sourceRef).toBe(sub.id);
    // Hoá đơn là event → nằm ở sổ, không phải ở identity của grant.
    const renewal = await ctx.prisma.creditTransaction.findFirstOrThrow({
      where: { userId: user.id, type: CreditTransactionType.RENEWAL },
    });
    expect(renewal.invoiceId).not.toBeNull();
    expect(renewal.referenceId).toBe(sub.id);

    const renewals = await ctx.prisma.creditTransaction.findMany({
      where: { userId: user.id, type: CreditTransactionType.RENEWAL },
    });
    expect(renewals).toHaveLength(1);
    expect(renewals[0].amount).toBe(ctx.freePlan.creditPolicy.creditAmount);
  });

  it("is idempotent: a second run does not grant credits again", async () => {
    const user = await ctx.createUser();
    const freeSubId = `sub_free_${rand()}`;
    await ctx.createSubscription(user.id, {
      pricingOptionId: ctx.freeOption.id,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: stalePeriodStart,
      providerSubscriptionId: freeSubId,
    });

    paidInvoices.set(
      freeSubId,
      invoicePayload(freeSubId, ctx.freeOption.providerPriceId!, {
        customer: user.providerCustomerId,
        billing_reason: "subscription_create",
        amount_due: 0,
        amount_paid: 0,
        payment_intent: null,
      }),
    );

    await cron().reconcile();
    await cron().reconcile();

    const renewals = await ctx.prisma.creditTransaction.findMany({
      where: { userId: user.id, type: CreditTransactionType.RENEWAL },
    });
    expect(renewals).toHaveLength(1);
    // Chạy hai lần không được cấp đôi số dư.
    expect(await ctx.subscriptionCredits(user.id)).toBe(
      ctx.freePlan.creditPolicy.creditAmount,
    );
  });

  it("leaves a subscription alone when the ledger already shows a grant for this period", async () => {
    // Số dư 0 nhưng ĐÃ có bút toán cấp cho kỳ hiện tại – tức là user tiêu hết, không phải
    // hỏng. Bằng chứng là sổ, không phải số dư.
    const user = await ctx.createUser();
    const freeSubId = `sub_free_${rand()}`;
    const sub = await ctx.createSubscription(user.id, {
      pricingOptionId: ctx.freeOption.id,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: stalePeriodStart,
      providerSubscriptionId: freeSubId,
    });

    // Kỳ này ĐÃ cấp rồi và user tiêu sạch: grant còn 0, nhưng bút toán RENEWAL vẫn nằm đó.
    // Dựng cả grant lẫn bút toán neo vào nó – đúng hình dạng CreditService sinh ra, thay vì
    // bút toán trần (grantId NULL) mà không đường ghi nào của PR2 tạo được nữa.
    const grant = await ctx.createSubGrant(user.id, sub.id, ctx.freePlan.creditPolicy.creditAmount);
    await ctx.prisma.creditGrant.update({
      where: { id: grant.id },
      data: { amountRemaining: 0 },
    });
    await ctx.prisma.creditTransaction.create({
      data: {
        userId: user.id,
        grantId: grant.id,
        type: CreditTransactionType.RENEWAL,
        amount: ctx.freePlan.creditPolicy.creditAmount,
        description: "already granted",
        referenceType: ReferenceType.SUBSCRIPTION,
        referenceId: sub.id,
      },
    });

    paidInvoices.set(
      freeSubId,
      invoicePayload(freeSubId, ctx.freeOption.providerPriceId!, {
        customer: user.providerCustomerId,
      }),
    );

    await cron().reconcile();

    expect(stripeMock.getLatestPaidInvoice).not.toHaveBeenCalledWith(freeSubId);

    // Không cấp bù: số dư 0 là do tiêu hết, không phải do hỏng.
    expect(await ctx.subscriptionCredits(user.id)).toBe(0);
    const renewals = await ctx.prisma.creditTransaction.findMany({
      where: { userId: user.id, type: CreditTransactionType.RENEWAL },
    });
    expect(renewals).toHaveLength(1);
  });
});
