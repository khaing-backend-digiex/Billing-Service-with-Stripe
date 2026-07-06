import Stripe from "stripe";
import { StripeWebhookService } from "../src/stripe/webhook/stripe-webhook.service";
import { TestContext, rand } from "./helpers/context";

/**
 * Lớp dedupe event-level của StripeWebhookService trên DB thật:
 * claim-first insert → chỉ 1 delivery trùng (kể cả đồng thời) chạy strategy.
 */
describe("StripeWebhookService event dedupe (real DB)", () => {
  const ctx = new TestContext();

  const makeEvent = (): Stripe.Event =>
    ({
      id: `evt_test_${ctx.runId}_${rand()}`,
      type: "invoice.paid",
      data: { object: {} },
    }) as unknown as Stripe.Event;

  const makeService = (handle: () => Promise<void>) =>
    new StripeWebhookService(
      ctx.prisma,
      { getStrategy: () => ({ canHandle: () => true, handle }) } as any,
    );

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("runs the strategy exactly once for two CONCURRENT deliveries of the same event", async () => {
    let handled = 0;
    const service = makeService(async () => {
      handled++;
      await new Promise((r) => setTimeout(r, 300)); // giữ claim in-flight đủ lâu
    });
    const event = makeEvent();

    const results = await Promise.allSettled([
      service.handleEvent(event),
      service.handleEvent(event),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(handled).toBe(1);

    const row = await ctx.prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.processedAt).not.toBeNull();
  });

  it("skips a replay of an already-processed event", async () => {
    let handled = 0;
    const service = makeService(async () => {
      handled++;
    });
    const event = makeEvent();

    await service.handleEvent(event);
    await service.handleEvent(event);

    expect(handled).toBe(1);
  });

  it("releases the claim on strategy failure so a Stripe retry can reprocess", async () => {
    const event = makeEvent();
    const failing = makeService(async () => {
      throw new Error("boom");
    });

    await expect(failing.handleEvent(event)).rejects.toThrow("boom");

    // Claim đã được nhả → không còn row chặn retry
    const afterFailure = await ctx.prisma.webhookEvent.findUnique({ where: { id: event.id } });
    expect(afterFailure).toBeNull();

    // Retry (delivery kế tiếp của Stripe) xử lý thành công
    let handled = 0;
    const healthy = makeService(async () => {
      handled++;
    });
    await healthy.handleEvent(event);
    expect(handled).toBe(1);

    const row = await ctx.prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.processedAt).not.toBeNull();
  });
});
