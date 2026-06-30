import { Module, forwardRef } from "@nestjs/common";
import { StripeController } from "./stripe.controller";
import { StripeService } from "./stripe.service";
import { StripeWebhookController } from "./webhook/stripe-webhook.controller";
import { StripeWebhookService } from "./webhook/stripe-webhook.service";
import { UsersModule } from "../users/users.module";
import { PricingModule } from "../pricing/pricing.module";

@Module({
  imports: [forwardRef(() => UsersModule), PricingModule],
  controllers: [StripeController, StripeWebhookController],
  providers: [StripeService, StripeWebhookService],
  exports: [StripeService],
})
export class StripeModule {}
