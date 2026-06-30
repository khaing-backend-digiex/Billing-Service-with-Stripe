import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { PaymentsService } from "./payments.service";
import { PaymentsController } from "./payments.controller";
import { StripeStrategy } from "./strategies/stripe.strategy";
import { Payment } from "../database/entities/payment.entity";
import { UsersModule } from "../users/users.module";
import { DatabaseModule } from "../database/database.module";

@Module({
  imports: [TypeOrmModule.forFeature([Payment]), UsersModule, DatabaseModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, StripeStrategy],
  exports: [PaymentsService, StripeStrategy],
})
export class PaymentsModule {}
