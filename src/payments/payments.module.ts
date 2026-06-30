import { Module } from "@nestjs/common";
import { PaymentsService } from "./payments.service";
import { PaymentsController } from "./payments.controller";
import { StripeStrategy } from "./strategies/stripe.strategy";
import { UsersModule } from "../users/users.module";
import { DatabaseModule } from "../database/database.module";

@Module({
  imports: [UsersModule, DatabaseModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, StripeStrategy],
  exports: [PaymentsService, StripeStrategy],
})
export class PaymentsModule {}
