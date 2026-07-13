import {
  CreditTransactionType,
  ReferenceType,
  SubscriptionStatus,
} from "@prisma/client";
import { FreePlanReconciliationCron } from "../src/cron/free-plan-reconciliation.cron";
import { PaidInvoiceSyncService } from "../src/stripe/sync/paid-invoice-sync.service";
import { InvoiceService } from "../src/stripe/invoice.service";
import { PaymentService } from "../src/stripe/payment.service";
import { StripeAdapter } from "../src/stripe/adapter/stripe.adapter";
import { TestContext, invoicePayload, rand } from "./helpers/context";

describe("FreePlanReconciliationCron – missing settlement (real DB, Stripe mocked)", () => {
  const ctx = new TestContext();
  const adapter = new StripeAdapter({ get: () => "sk_test_dummy" } as any);

  const pricingServiceStub = {
    findByProviderPriceId: (priceId: string) =>
      ctx.prisma.pricingOption.findFirst({
        where: { providerPriceId: priceId },
        include: { plan: true },
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

  const cron = () =>
    new FreePlanReconciliationCron(
      stripeMock as any,
      usersMock as any,
      subscriptionSyncMock as any,
      new PaidInvoiceSyncService(
        ctx.prisma,
        pricingServiceStub as any,
        new InvoiceService(ctx.prisma),
        new PaymentService(ctx.prisma),
      ),
      ctx.prisma,
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
      subscriptionCreditsRemaining: 0,
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

    const after = await ctx.prisma.subscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(after.subscriptionCreditsRemaining).toBe(ctx.freePlan.renewalCredits);

    const grants = await ctx.prisma.creditTransaction.findMany({
      where: { userId: user.id, type: CreditTransactionType.RENEWAL },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0].amount).toBe(ctx.freePlan.renewalCredits);
  });

  it("is idempotent: a second run does not grant credits again", async () => {
    const user = await ctx.createUser();
    const freeSubId = `sub_free_${rand()}`;
    await ctx.createSubscription(user.id, {
      pricingOptionId: ctx.freeOption.id,
      status: SubscriptionStatus.ACTIVE,
      subscriptionCreditsRemaining: 0,
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

    const grants = await ctx.prisma.creditTransaction.findMany({
      where: { userId: user.id, type: CreditTransactionType.RENEWAL },
    });
    expect(grants).toHaveLength(1);
  });

  it("leaves a subscription alone when the ledger already shows a grant for this period", async () => {
    // Số dư 0 nhưng ĐÃ có bút toán cấp cho kỳ hiện tại – tức là user tiêu hết, không phải
    // hỏng. Bằng chứng là sổ, không phải số dư.
    const user = await ctx.createUser();
    const freeSubId = `sub_free_${rand()}`;
    const sub = await ctx.createSubscription(user.id, {
      pricingOptionId: ctx.freeOption.id,
      status: SubscriptionStatus.ACTIVE,
      subscriptionCreditsRemaining: 0,
      currentPeriodStart: stalePeriodStart,
      providerSubscriptionId: freeSubId,
    });

    await ctx.prisma.creditTransaction.create({
      data: {
        userId: user.id,
        type: CreditTransactionType.RENEWAL,
        amount: ctx.freePlan.renewalCredits,
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

    const after = await ctx.prisma.subscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(after.subscriptionCreditsRemaining).toBe(0);
  });
});
