import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { PrismaService } from "../../database/prisma.service";
import { PaymentProvider, WebhookEventStatus } from "@prisma/client";
import { WebhookStrategyFactory } from "./strategies/webhook-strategy.factory";
import { DatabaseException } from "../../common/exceptions/database.exception";
import { ExternalServiceException } from "../../common/exceptions/external-service.exception";

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
        await this.markProcessed(event.id, WebhookEventStatus.SUCCESS);
      } else {
        this.logger.log(`Unhandled event type: ${event.type}`);
        await this.markProcessed(event.id, WebhookEventStatus.UNHANDLED);
      }
    } catch (error) {
      await this.markFailed(event.id, error instanceof Error ? error.message : String(error));
      
      if (
        error instanceof DatabaseException ||
        error instanceof ExternalServiceException
      ) {
        throw error;
      }

      this.logger.error(
        `Logic error in webhook ${event.id}, not throwing to prevent retry.`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async claimEvent(event: Stripe.Event): Promise<boolean> {
    const obj = event.data.object as any;
    const objectId = obj?.id ?? null;
    const objectType = obj?.object ?? null;

    try {
      await this.prisma.webhookEvent.create({
        data: {
          id: event.id,
          provider: PaymentProvider.STRIPE,
          eventType: event.type,
          objectId,
          objectType,
          status: WebhookEventStatus.RECEIVED,
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

    if (existing.status === WebhookEventStatus.SUCCESS || existing.status === WebhookEventStatus.UNHANDLED) {
      this.logger.log(`Skipping already processed webhook event: ${eventId}`);
      return false;
    }

    const claimAge = Date.now() - existing.createdAt.getTime();

    if (existing.status === WebhookEventStatus.RECEIVED && claimAge < STALE_CLAIM_MS) {
      this.logger.log(
        `Event ${eventId} is already being processed – skipping duplicate delivery`,
      );
      return false;
    }

    this.logger.warn(
      `Reclaiming webhook event ${eventId} (Status: ${existing.status})`,
    );

    await this.prisma.webhookEvent.update({
      where: { id: eventId },
      data: {
        status: WebhookEventStatus.RECEIVED,
        attempts: { increment: 1 },
        errorMessage: null,
      },
    });

    return true;
  }

  private async markProcessed(eventId: string, status: WebhookEventStatus): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id: eventId },
      data: {
        status,
        processedAt: new Date(),
      },
    });
  }

  private async markFailed(eventId: string, errorMessage: string): Promise<void> {
    try {
      await this.prisma.webhookEvent.update({
        where: { id: eventId },
        data: {
          status: WebhookEventStatus.FAILED,
          errorMessage,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to mark event ${eventId} as failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}