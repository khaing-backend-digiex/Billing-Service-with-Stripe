import {
  Controller,
  Post,
  Req,
  Headers,
  BadRequestException,
  Logger,
  RawBody,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiExcludeEndpoint } from "@nestjs/swagger";
import { Request } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { StripeService } from "../stripe.service";
import { StripeWebhookService } from "./stripe-webhook.service";

@ApiTags("Stripe Webhooks")
@Controller("stripe")
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly webhookService: StripeWebhookService,
  ) {}

  @Public()
  @Post("webhook")
  @ApiOperation({ summary: "Stripe webhook endpoint" })
  @ApiExcludeEndpoint()
  async handleWebhook(
    @RawBody() rawBody: Buffer,
    @Headers("stripe-signature") signature: string,
  ) {
    if (!signature) {
      throw new BadRequestException("Missing stripe-signature header");
    }

    if (!rawBody) {
      throw new BadRequestException("Missing request body");
    }

    try {
      const event = this.stripeService.constructWebhookEvent(
        rawBody,
        signature,
      );

      this.logger.log(`📩 Received Stripe event: ${event.type} (${event.id})`);

      await this.webhookService.handleEvent(event);

      return { received: true };
    } catch (error) {
      this.logger.error(
        `❌ Webhook error: ${error instanceof Error ? error.message : error}`,
      );
      throw new BadRequestException(`Webhook signature verification failed`);
    }
  }
}
