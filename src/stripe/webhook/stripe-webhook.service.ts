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
    // 1. Idempotency check
    const existingEvent = await this.prisma.webhookEvent.findUnique({
      where: { id: event.id },
    });

    if (existingEvent) {
      this.logger.log('Skipping duplicate webhook event: ' + event.id);
      return;
    }

    // 2. Run strategy trước — nếu fail thì Stripe sẽ retry và lần sau vẫn xử lý được
    const strategy = this.strategyFactory.getStrategy(event.type);

    if (strategy) {
      await strategy.handle(event);
    } else {
      this.logger.log(`Unhandled event type: ${event.type}`);
    }

    // 3. Chỉ đánh dấu processed sau khi strategy chạy thành công
    // Insert as processed (since we already ran the strategy successfully)
    await this.prisma.webhookEvent.create({
      data: {
        id: event.id,
        provider: PaymentProvider.STRIPE,
        eventType: event.type,
        payload: event as any,
        processedAt: new Date(),
      },
    });
  }
}

