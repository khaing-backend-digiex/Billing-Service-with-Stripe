import { Module } from "@nestjs/common";
import { StripeModule } from "../stripe/stripe.module";
import { UsersModule } from "../users/users.module";
import { CreditResetCronService } from "./credit-reset.cron";
import { FreePlanReconciliationCron } from "./free-plan-reconciliation.cron";
import { CleanupTaskCron } from "./cleanup-task.cron";

@Module({
  imports: [StripeModule, UsersModule],
  providers: [
    CreditResetCronService,
    FreePlanReconciliationCron,
    CleanupTaskCron,
  ],
})
export class CronModule {}
