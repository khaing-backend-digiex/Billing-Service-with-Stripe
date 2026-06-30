import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { PrismaService } from "../../database/prisma.service";
import { PaymentProvider } from "@prisma/client";
import { WebhookStrategyFactory } from "./strategies/webhook-strategy.factory";

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly strategyFactory: WebhookStrategyFactory,
  ) {}

  async handleEvent(event: Stripe.Event): Promise<void> {
    // 1. Check if event is already processed
    const existingEvent = await this.prisma.webhookEvent.findUnique({
      where: { eventId: event.id },
    });

    if (existingEvent) {
      this.logger.log(`Webhook event ${event.id} already processed. Skipping.`);
      return; // Idempotent: Ignore duplicate webhook
    }

    // 2. Lock event by inserting it
    try {
      await this.prisma.webhookEvent.create({
        data: {
          id: event.id,
          eventId: event.id,
          provider: PaymentProvider.STRIPE,
          eventType: event.type,
          payload: event as any,
        },
      });
    } catch (e) {
      this.logger.log(`Concurrent webhook event ${event.id} detected. Skipping.`);
      return;
    }

    const strategy = this.strategyFactory.getStrategy(event.type);
    
    if (strategy) {
      try {
        await strategy.handle(event);
        // Mark as processed
        await this.prisma.webhookEvent.update({
          where: { eventId: event.id },
          data: { processedAt: new Date() },
        });
      } catch (err) {
        this.logger.error(`Error processing webhook ${event.id}:`, err);
        // If it fails, delete the record so Stripe's retry will process it again
        await this.prisma.webhookEvent.delete({
          where: { eventId: event.id },
        });
        throw err;
      }
    } else {
      this.logger.log(`Unhandled event type: ${event.type}`);
      // Mark as processed since we don't care about it
      await this.prisma.webhookEvent.update({
        where: { eventId: event.id },
        data: { processedAt: new Date() },
      });
    }
  }
}
