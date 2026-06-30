import { Module } from "@nestjs/common";
import { StripeService } from "./stripe.service";
import { StripeWebhookController } from "./webhook/stripe-webhook.controller";
import { StripeWebhookService } from "./webhook/stripe-webhook.service";
import { DatabaseModule } from "../database/database.module";
import { UsersModule } from "../users/users.module";

@Module({
  imports: [DatabaseModule, UsersModule],
  controllers: [StripeWebhookController],
  providers: [StripeService, StripeWebhookService],
  exports: [StripeService],
})
export class StripeModule {}
