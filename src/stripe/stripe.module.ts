import { Module } from "@nestjs/common";
import { StripeService } from "./stripe.service";
import { StripeWebhookController } from "./webhook/stripe-webhook.controller";
import { StripeWebhookService } from "./webhook/stripe-webhook.service";
import { DatabaseModule } from "../database/database.module";

@Module({
  imports: [DatabaseModule],
  controllers: [StripeWebhookController],
  providers: [StripeService, StripeWebhookService],
  exports: [StripeService],
})
export class StripeModule {}
