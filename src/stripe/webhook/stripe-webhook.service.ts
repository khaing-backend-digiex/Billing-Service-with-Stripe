import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { PrismaService } from "../../database/prisma.service";
import { PaymentProvider } from "@prisma/client";
import { WebhookStrategyFactory } from "./strategies/webhook-strategy.factory";

// Claim tồn tại (processedAt null) lâu hơn mốc này → coi như process trước đã
// crash giữa chừng, cho phép xử lý lại thay vì skip mãi mãi.
const STALE_CLAIM_MS = 10 * 60_000;

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === "P2002";
}

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly strategyFactory: WebhookStrategyFactory,
  ) {}

  async handleEvent(event: Stripe.Event): Promise<void> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          id: event.id,
          provider: PaymentProvider.STRIPE,
          eventType: event.type,
          payload: event as any,
          processedAt: null,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const existing = await this.prisma.webhookEvent.findUnique({
        where: { id: event.id },
      });

      if (existing?.processedAt) {
        this.logger.log(`Skipping duplicate webhook event: ${event.id}`);
        return;
      }

      const claimAge = existing ? Date.now() - existing.createdAt.getTime() : Infinity;
      if (claimAge < STALE_CLAIM_MS) {
        this.logger.log(`Event ${event.id} is already being processed – skipping duplicate delivery`);
        return;
      }

      this.logger.warn(`Reclaiming stale webhook event ${event.id} (claimed ${Math.round(claimAge / 1000)}s ago)`);
    }

    try {
      const strategy = this.strategyFactory.getStrategy(event.type);
      if (strategy) {
        await strategy.handle(event);
      } else {
        this.logger.log(`Unhandled event type: ${event.type}`);
      }
    } catch (error) {
      await this.prisma.webhookEvent
        .deleteMany({ where: { id: event.id, processedAt: null } })
        .catch((releaseError) =>
          this.logger.error(`Failed to release claim for event ${event.id}: ${releaseError}`),
        );
      throw error;
    }

    await this.prisma.webhookEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date() },
    });
  }
}
