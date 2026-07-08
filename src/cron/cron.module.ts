import { Module } from "@nestjs/common";
import { StripeModule } from "../stripe/stripe.module";
import { UsersModule } from "../users/users.module";
import { CreditResetCronService } from "./credit-reset.cron";
import { FreePlanReconciliationCron } from "./free-plan-reconciliation.cron";

@Module({
  imports: [StripeModule, UsersModule],
  providers: [CreditResetCronService, FreePlanReconciliationCron],
})
export class CronModule {}
