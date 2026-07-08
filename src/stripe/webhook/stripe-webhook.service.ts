import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { PrismaService } from "../../database/prisma.service";
import { PaymentProvider } from "@prisma/client";
import { WebhookStrategyFactory } from "./strategies/webhook-strategy.factory";

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
    const claimed = await this.claimEvent(event);

    if (!claimed) {
      return;
    }

    const strategy = this.strategyFactory.getStrategy(event.type);

    try {
      if (strategy) {
        await strategy.handle(event);
      } else {
        this.logger.log(`Unhandled event type: ${event.type}`);
      }

      await this.markProcessed(event.id);
    } catch (error) {
      await this.releaseClaim(event.id);
      throw error;
    }
  }

  private async claimEvent(event: Stripe.Event): Promise<boolean> {
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

      return true;
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      return this.handleDuplicateClaim(event.id);
    }
  }

  private async handleDuplicateClaim(eventId: string): Promise<boolean> {
    const existing = await this.prisma.webhookEvent.findUnique({
      where: { id: eventId },
    });

    if (!existing) {
      return true;
    }

    if (existing.processedAt) {
      this.logger.log(`Skipping duplicate webhook event: ${eventId}`);
      return false;
    }

    const claimAge = Date.now() - existing.createdAt.getTime();

    if (claimAge < STALE_CLAIM_MS) {
      this.logger.log(
        `Event ${eventId} is already being processed – skipping duplicate delivery`,
      );
      return false;
    }

    this.logger.warn(
      `Reclaiming stale webhook event ${eventId} (${Math.round(
        claimAge / 1000,
      )}s old)`,
    );

    return true;
  }

  private async markProcessed(eventId: string): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id: eventId },
      data: {
        processedAt: new Date(),
      },
    });
  }

  private async releaseClaim(eventId: string): Promise<void> {
    try {
      await this.prisma.webhookEvent.deleteMany({
        where: {
          id: eventId,
          processedAt: null,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to release claim for event ${eventId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}