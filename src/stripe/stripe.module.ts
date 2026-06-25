import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { StripeService } from "./stripe.service";
import { StripeController } from "./stripe.controller";
import { StripeWebhookController } from "./webhook/stripe-webhook.controller";
import { StripeWebhookService } from "./webhook/stripe-webhook.service";
import { Payment } from "../database/entities/payment.entity";
import { UsersModule } from "../users/users.module";

@Module({
  imports: [TypeOrmModule.forFeature([Payment]), UsersModule],
  controllers: [StripeController, StripeWebhookController],
  providers: [StripeService, StripeWebhookService],
  exports: [StripeService],
})
export class StripeModule {}
