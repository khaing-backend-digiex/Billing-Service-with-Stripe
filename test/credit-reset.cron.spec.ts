import {
  CreditGrantSourceType,
  CreditTransactionType,
  SubscriptionEventType,
} from "@prisma/client";
import { CreditResetCronService } from "../src/cron/credit-reset.cron";
import { CreditService } from "../src/credits/credit.service";
import { CreditRepository } from "../src/credits/credit.repository";
import { TestContext } from "./helpers/context";

/**
 * Reset = revoke grant SUBSCRIPTION cũ + tạo grant mới (`resetSubscriptionAllowance`), chứ
 * không phải gán lại một con số lên Subscription — Subscription không còn cột số dư nào.
 * Nên "đã reset chưa" phải đọc ở CreditGrant.
 *
 * Điều đó đổi cả ý nghĩa của "credit chưa tiêu bị mất khi reset": trước là số bị ghi đè,
 * giờ là grant cũ bị revoke bằng một bút toán EXPIRATION — mất credit giờ có dấu vết.
 */
describe("CreditResetCronService (real DB)", () => {
  const ctx = new TestContext();
  let cron: CreditResetCronService;

  const subCredits = (userId: string) =>
    ctx.subscriptionCredits(userId);

  beforeAll(async () => {
    await ctx.seed();
    const creditRepo = new CreditRepository(ctx.prisma);
    const creditService = new CreditService(ctx.prisma, creditRepo);
    cron = new CreditResetCronService(ctx.prisma, creditService);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("grants credits and advances nextCreditResetAt for due subscriptions", async () => {
    const user = await ctx.createUser();
    const sub = await ctx.createSubscription(user.id, {
      nextCreditResetAt: new Date(Date.now() - 86_400_000), // quá hạn 1 ngày
      currentPeriodEnd: new Date(Date.now() + 40 * 86_400_000),
    });
    await ctx.createSubGrant(user.id, sub.id, 3); // số dư còn thừa của kỳ trước

    await cron.handleCreditReset();

    const after = await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.nextCreditResetAt.getTime()).toBeGreaterThan(Date.now());

    // Số dư = đúng hạn mức của kỳ mới. 3 credit thừa bị revoke, KHÔNG cộng dồn.
    expect(await subCredits(user.id)).toBe(ctx.plan.creditPolicy.creditAmount);

    const grants = await ctx.prisma.creditGrant.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    expect(grants).toHaveLength(2); // grant cũ (đã revoke) + grant mới
    expect(grants[0].amountRemaining).toBe(0);
    expect(grants[1].amountGranted).toBe(ctx.plan.creditPolicy.creditAmount);
    // Cron reset cấp SUBSCRIPTION_RESET, không phải ALLOCATION – khác nguồn, cùng khái niệm.
    expect(grants[1].sourceType).toBe(CreditGrantSourceType.SUBSCRIPTION_RESET);
    // Entity, không phải hoá đơn: reset không có hoá đơn nào đứng sau.
    expect(grants[1].sourceRef).toBe(sub.id);

    const renewals = await ctx.prisma.creditTransaction.findMany({
      where: { userId: user.id, type: CreditTransactionType.RENEWAL },
    });
    expect(renewals).toHaveLength(1);
    expect(renewals[0].amount).toBe(ctx.plan.creditPolicy.creditAmount);

    // 3 credit thừa biến mất phải có bút toán, không được lặng lẽ.
    const expirations = await ctx.prisma.creditTransaction.findMany({
      where: { userId: user.id, type: CreditTransactionType.EXPIRATION },
    });
    expect(expirations).toHaveLength(1);
    expect(expirations[0].amount).toBe(-3);

    const events = await ctx.prisma.subscriptionEvent.findMany({
      where: { subscriptionId: sub.id, type: SubscriptionEventType.RENEWED },
    });
    expect(events).toHaveLength(1);
  });

  it("is idempotent: a second run does not grant credits again", async () => {
    const user = await ctx.createUser();
    const sub = await ctx.createSubscription(user.id, {
      nextCreditResetAt: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 40 * 86_400_000),
    });

    await cron.handleCreditReset();
    await cron.handleCreditReset();

    const txs = await ctx.prisma.creditTransaction.findMany({
      where: { userId: user.id, type: CreditTransactionType.RENEWAL },
    });
    expect(txs).toHaveLength(1);

    // Chạy hai lần không được cấp đôi số dư.
    expect(await subCredits(user.id)).toBe(ctx.plan.creditPolicy.creditAmount);
    const grants = await ctx.prisma.creditGrant.findMany({
      where: { userId: user.id, sourceRef: sub.id },
    });
    expect(grants).toHaveLength(1);
  });

  it("grants exactly once when two runs execute concurrently (optimistic lock)", async () => {
    const user = await ctx.createUser();
    await ctx.createSubscription(user.id, {
      nextCreditResetAt: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 40 * 86_400_000),
    });

    await Promise.all([cron.handleCreditReset(), cron.handleCreditReset()]);

    const txs = await ctx.prisma.creditTransaction.findMany({
      where: { userId: user.id, type: CreditTransactionType.RENEWAL },
    });
    expect(txs).toHaveLength(1);
    expect(await subCredits(user.id)).toBe(ctx.plan.creditPolicy.creditAmount);
  });

  it("skips when the next reset would exceed currentPeriodEnd (invoice.paid handles renewal)", async () => {
    const user = await ctx.createUser();
    const sub = await ctx.createSubscription(user.id, {
      nextCreditResetAt: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000), // reset kế tiếp (~+29d) sẽ vượt mốc này
    });
    await ctx.createSubGrant(user.id, sub.id, 7);

    await cron.handleCreditReset();

    expect(await subCredits(user.id)).toBe(7); // không đổi
    const txs = await ctx.prisma.creditTransaction.findMany({ where: { userId: user.id } });
    expect(txs).toHaveLength(0);
  });

  it("skips subscriptions that are not ACTIVE", async () => {
    const user = await ctx.createUser();
    const sub = await ctx.createSubscription(user.id, {
      status: "CANCELLED" as any,
      nextCreditResetAt: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 40 * 86_400_000),
    });
    await ctx.createSubGrant(user.id, sub.id, 10);

    await cron.handleCreditReset();

    expect(await subCredits(user.id)).toBe(10);
    const txs = await ctx.prisma.creditTransaction.findMany({ where: { userId: user.id } });
    expect(txs).toHaveLength(0);
  });

  it("skips subscriptions whose nextCreditResetAt is in the future", async () => {
    const user = await ctx.createUser();
    const sub = await ctx.createSubscription(user.id, {
      nextCreditResetAt: new Date(Date.now() + 2 * 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 40 * 86_400_000),
    });
    await ctx.createSubGrant(user.id, sub.id, 15);

    await cron.handleCreditReset();

    expect(await subCredits(user.id)).toBe(15);
    const txs = await ctx.prisma.creditTransaction.findMany({ where: { userId: user.id } });
    expect(txs).toHaveLength(0);
  });

  it("skips expired subscriptions", async () => {
    const user = await ctx.createUser();
    const sub = await ctx.createSubscription(user.id, {
      nextCreditResetAt: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() - 1_000),
    });
    await ctx.createSubGrant(user.id, sub.id, 12);

    await cron.handleCreditReset();

    expect(await subCredits(user.id)).toBe(12);
    const txs = await ctx.prisma.creditTransaction.findMany({ where: { userId: user.id } });
    expect(txs).toHaveLength(0);
  });

  it("resets only subscriptions that are due", async () => {
    const user1 = await ctx.createUser();
    const user2 = await ctx.createUser();

    await ctx.createSubscription(user1.id, {
      nextCreditResetAt: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 40 * 86_400_000),
    });

    const sub2 = await ctx.createSubscription(user2.id, {
      nextCreditResetAt: new Date(Date.now() + 5 * 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 40 * 86_400_000),
    });
    await ctx.createSubGrant(user2.id, sub2.id, 99);

    await cron.handleCreditReset();

    const txs1 = await ctx.prisma.creditTransaction.findMany({ where: { userId: user1.id } });
    const txs2 = await ctx.prisma.creditTransaction.findMany({ where: { userId: user2.id } });

    expect(txs1).toHaveLength(1);
    expect(txs2).toHaveLength(0);
    expect(await subCredits(user2.id)).toBe(99); // chưa tới hạn, giữ nguyên
  });
});
