import { Module } from "@nestjs/common";
import { PaymentsService } from "./payments.service";
import { PaymentsController } from "./payments.controller";
import { UsersModule } from "../users/users.module";
import { DatabaseModule } from "../database/database.module";
import { StripeModule } from "../stripe/stripe.module";

@Module({
  imports: [UsersModule, DatabaseModule, StripeModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
