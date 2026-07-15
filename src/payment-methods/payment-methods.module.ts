import { Module } from "@nestjs/common";
import { PaymentMethodsService } from "./payment-methods.service";
import { PaymentMethodsController } from "./payment-methods.controller";
import { UsersModule } from "../users/users.module";
import { DatabaseModule } from "../database/database.module";
import { StripeModule } from "../stripe/stripe.module";

@Module({
  imports: [UsersModule, DatabaseModule, StripeModule],
  controllers: [PaymentMethodsController],
  providers: [PaymentMethodsService],
  exports: [PaymentMethodsService],
})
export class PaymentMethodsModule {}
