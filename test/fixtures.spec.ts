import { CreditGrantSourceType, SubscriptionStatus } from "@prisma/client";
import { TestContext } from "./helpers/context";

/**
 * Test cho chính test fixture (C1). Mục đích: A và B xây test lên `TestContext` mà không
 * phải mở `context.ts` — nên hợp đồng của nó phải được kiểm chứng ở một chỗ.
 *
 * Kiểm luôn cả các CHECK/partial index khai báo trong migration
 * `20260716020000_multi_subscription_expand` thực sự chặn qua đường Prisma, không chỉ
 * qua raw SQL.
 */
describe("TestContext fixtures (real DB)", () => {
  const ctx = new TestContext();

  beforeAll(async () => {
    await ctx.seed();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  describe("createGrant", () => {
    it("defaults to an unspent ADDON grant on the seeded product", async () => {
      const user = await ctx.createUser();
      const grant = await ctx.createGrant(user.id);

      expect(grant.productId).toBe(ctx.product.id);
      expect(grant.sourceType).toBe(CreditGrantSourceType.ADDON);
      expect(grant.amountGranted).toBe(100);
      expect(grant.amountRemaining).toBe(100);
    });

    it("accepts overrides for partially spent grants and priority", async () => {
      const user = await ctx.createUser();
      const grant = await ctx.createGrant(user.id, {
        amountGranted: 50,
        amountRemaining: 20,
        priority: 10,
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      expect(grant.amountRemaining).toBe(20);
      expect(grant.priority).toBe(10);
      expect(grant.expiresAt).not.toBeNull();
    });

    it("lets a SUBSCRIPTION grant through when sourceRef is set", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id);
      const grant = await ctx.createGrant(user.id, {
        sourceType: CreditGrantSourceType.SUBSCRIPTION,
        sourceRef: sub.id,
      });

      expect(grant.sourceRef).toBe(sub.id);
    });
  });

  describe("DB constraints reject invalid grants", () => {
    it("rejects a SUBSCRIPTION grant without sourceRef", async () => {
      const user = await ctx.createUser();
      await expect(
        ctx.createGrant(user.id, { sourceType: CreditGrantSourceType.SUBSCRIPTION }),
      ).rejects.toThrow();
    });

    it("rejects amountRemaining greater than amountGranted", async () => {
      const user = await ctx.createUser();
      await expect(
        ctx.createGrant(user.id, { amountGranted: 10, amountRemaining: 11 }),
      ).rejects.toThrow();
    });

    it("rejects negative amountRemaining", async () => {
      const user = await ctx.createUser();
      await expect(
        ctx.createGrant(user.id, { amountGranted: 10, amountRemaining: -1 }),
      ).rejects.toThrow();
    });
  });

  describe("createSubscription", () => {
    it("defaults to the seeded product and PROVIDER billing mode", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id);

      expect(sub.productId).toBe(ctx.product.id);
      expect(sub.billingMode).toBe("PROVIDER");
      expect(sub.providerSubscriptionId).not.toBeNull();
    });

    it("rejects billingMode NONE while a providerSubscriptionId is set", async () => {
      const user = await ctx.createUser();
      await expect(
        ctx.createSubscription(user.id, { billingMode: "NONE" }),
      ).rejects.toThrow();
    });

    it("allows a Free row: billingMode NONE with no provider subscription", async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id, {
        billingMode: "NONE",
        provider: null,
        providerSubscriptionId: null,
        pricingOptionId: ctx.freeOption.id,
      });

      expect(sub.billingMode).toBe("NONE");
      expect(sub.providerSubscriptionId).toBeNull();
    });
  });

  describe("createCatalogTree", () => {
    it("builds an independent product/plan/pricingOption branch", async () => {
      const tree = await ctx.createCatalogTree("ocr");

      expect(tree.product.id).not.toBe(ctx.product.id);
      expect(tree.plan.productId).toBe(tree.product.id);
      expect(tree.pricingOption.productId).toBe(tree.product.id);
      expect(tree.plan.creditPolicy.creditAmount).toBe(100);
    });

    it("keeps grants scoped per product", async () => {
      const user = await ctx.createUser();
      const tree = await ctx.createCatalogTree("scoped");

      await ctx.createGrant(user.id, { amountGranted: 100 });
      await ctx.createGrant(user.id, { productId: tree.product.id, amountGranted: 30 });

      const first = await ctx.prisma.creditGrant.findMany({
        where: { userId: user.id, productId: ctx.product.id },
      });
      const second = await ctx.prisma.creditGrant.findMany({
        where: { userId: user.id, productId: tree.product.id },
      });

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(second[0].amountGranted).toBe(30);
    });
  });

  // TODO(PR3 – Dev B): bật lại sau khi drop `Subscription.userId @unique` và đổi
  // `User.subscription` thành `subscriptions[]`. Hiện `@unique` chặn ở DB nên hai sub
  // cùng user là không thể, dù chúng khác product. Đây chính là invariant mà partial
  // unique index `(userId, productId) WHERE status IN ('ACTIVE','PAST_DUE')` phải cho phép.
  it.skip("allows one live subscription per product for the same user", async () => {
    const user = await ctx.createUser();
    await ctx.createTwoProductSubs(user.id);

    const subs = await ctx.prisma.subscription.findMany({ where: { userId: user.id } });
    expect(subs).toHaveLength(2);
  });

  // TODO(PR3 – Dev B): partial unique index phải chặn sub live THỨ HAI trên CÙNG product.
  it.skip("rejects a second live subscription on the same product", async () => {
    const user = await ctx.createUser();
    await ctx.createSubscription(user.id, { status: SubscriptionStatus.ACTIVE });

    await expect(
      ctx.createSubscription(user.id, { status: SubscriptionStatus.ACTIVE }),
    ).rejects.toThrow();
  });
});
