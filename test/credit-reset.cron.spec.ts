import { CreditTransactionType, SubscriptionEventType } from "@prisma/client";
import { CreditResetCronService } from "../src/cron/credit-reset.cron";
import { CreditService } from "../src/credits/credit.service";
import { CreditRepository } from "../src/credits/credit.repository";
import { TestContext } from "./helpers/context";

describe("CreditResetCronService (real DB)", () => {
  const ctx = new TestContext();
  let cron: CreditResetCronService;

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
      subscriptionCreditsRemaining: 3,
      nextCreditResetAt: new Date(Date.now() - 86_400_000), // quá hạn 1 ngày
      currentPeriodEnd: new Date(Date.now() + 40 * 86_400_000),
    });

    await cron.handleCreditReset();

    const after = await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.subscriptionCreditsRemaining).toBe(ctx.plan.creditPolicy.creditAmount);
    expect(after.nextCreditResetAt.getTime()).toBeGreaterThan(Date.now());

    const txs = await ctx.prisma.creditTransaction.findMany({
      where: { userId: user.id, type: CreditTransactionType.RENEWAL },
    });
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBe(ctx.plan.creditPolicy.creditAmount);

    const events = await ctx.prisma.subscriptionEvent.findMany({
      where: { subscriptionId: sub.id, type: SubscriptionEventType.RENEWED },
    });
    expect(events).toHaveLength(1);
  });

  it("is idempotent: a second run does not grant credits again", async () => {
    const user = await ctx.createUser();
    const sub = await ctx.createSubscription(user.id, {
      subscriptionCreditsRemaining: 0,
      nextCreditResetAt: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 40 * 86_400_000),
    });

    await cron.handleCreditReset();
    await cron.handleCreditReset();

    const txs = await ctx.prisma.creditTransaction.findMany({
      where: { userId: user.id, type: CreditTransactionType.RENEWAL },
    });
    expect(txs).toHaveLength(1);

    const after = await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.subscriptionCreditsRemaining).toBe(ctx.plan.creditPolicy.creditAmount);
  });

  it("grants exactly once when two runs execute concurrently (optimistic lock)", async () => {
    const user = await ctx.createUser();
    await ctx.createSubscription(user.id, {
      subscriptionCreditsRemaining: 0,
      nextCreditResetAt: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 40 * 86_400_000),
    });

    await Promise.all([cron.handleCreditReset(), cron.handleCreditReset()]);

    const txs = await ctx.prisma.creditTransaction.findMany({
      where: { userId: user.id, type: CreditTransactionType.RENEWAL },
    });
    expect(txs).toHaveLength(1);
  });

  it("skips when the next reset would exceed currentPeriodEnd (invoice.paid handles renewal)", async () => {
    const user = await ctx.createUser();
    const sub = await ctx.createSubscription(user.id, {
      subscriptionCreditsRemaining: 7,
      nextCreditResetAt: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000), // reset kế tiếp (~+29d) sẽ vượt mốc này
    });

    await cron.handleCreditReset();

    const after = await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.subscriptionCreditsRemaining).toBe(7); // không đổi
    const txs = await ctx.prisma.creditTransaction.findMany({ where: { userId: user.id } });
    expect(txs).toHaveLength(0);
  });

  it("skips subscriptions that are not ACTIVE", async () => {
  const user = await ctx.createUser();

  const sub = await ctx.createSubscription(user.id, {
    status: "CANCELLED" as any,
    subscriptionCreditsRemaining: 10,
    nextCreditResetAt: new Date(Date.now() - 86_400_000),
    currentPeriodEnd: new Date(Date.now() + 40 * 86_400_000),
  });

  await cron.handleCreditReset();

  const after = await ctx.prisma.subscription.findUniqueOrThrow({
    where: { id: sub.id },
  });

  expect(after.subscriptionCreditsRemaining).toBe(10);

  const txs = await ctx.prisma.creditTransaction.findMany({
    where: { userId: user.id },
  });

  expect(txs).toHaveLength(0);
});

it("skips subscriptions whose nextCreditResetAt is in the future", async () => {
  const user = await ctx.createUser();

  const sub = await ctx.createSubscription(user.id, {
    subscriptionCreditsRemaining: 15,
    nextCreditResetAt: new Date(Date.now() + 2 * 86_400_000),
    currentPeriodEnd: new Date(Date.now() + 40 * 86_400_000),
  });

  await cron.handleCreditReset();

  const after = await ctx.prisma.subscription.findUniqueOrThrow({
    where: { id: sub.id },
  });

  expect(after.subscriptionCreditsRemaining).toBe(15);

  const txs = await ctx.prisma.creditTransaction.findMany({
    where: { userId: user.id },
  });

  expect(txs).toHaveLength(0);
});

it("skips expired subscriptions", async () => {
  const user = await ctx.createUser();

  const sub = await ctx.createSubscription(user.id, {
    subscriptionCreditsRemaining: 12,
    nextCreditResetAt: new Date(Date.now() - 86_400_000),
    currentPeriodEnd: new Date(Date.now() - 1_000),
  });

  await cron.handleCreditReset();

  const after = await ctx.prisma.subscription.findUniqueOrThrow({
    where: { id: sub.id },
  });

  expect(after.subscriptionCreditsRemaining).toBe(12);

  const txs = await ctx.prisma.creditTransaction.findMany({
    where: { userId: user.id },
  });

  expect(txs).toHaveLength(0);
});

it("resets only subscriptions that are due", async () => {
  const user1 = await ctx.createUser();
  const user2 = await ctx.createUser();

  await ctx.createSubscription(user1.id, {
    subscriptionCreditsRemaining: 0,
    nextCreditResetAt: new Date(Date.now() - 86_400_000),
    currentPeriodEnd: new Date(Date.now() + 40 * 86_400_000),
  });

  await ctx.createSubscription(user2.id, {
    subscriptionCreditsRemaining: 99,
    nextCreditResetAt: new Date(Date.now() + 5 * 86_400_000),
    currentPeriodEnd: new Date(Date.now() + 40 * 86_400_000),
  });

  await cron.handleCreditReset();

  const txs1 = await ctx.prisma.creditTransaction.findMany({
    where: { userId: user1.id },
  });

  const txs2 = await ctx.prisma.creditTransaction.findMany({
    where: { userId: user2.id },
  });

  expect(txs1).toHaveLength(1);
  expect(txs2).toHaveLength(0);
});


});
