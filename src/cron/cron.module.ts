import { Module } from "@nestjs/common";
import { StripeModule } from "../stripe/stripe.module";
import { UsersModule } from "../users/users.module";
import { CreditResetCronService } from "./credit-reset.cron";
import { FreePlanReconciliationCron } from "./free-plan-reconciliation.cron";
import { CleanupTaskCron } from "./cleanup-task.cron";
import { CreditsModule } from "../credits/credits.module";
import { CreditReconciliationCron } from "./credit-reconciliation.cron";

@Module({
  imports: [StripeModule, UsersModule, CreditsModule],
  providers: [
    CreditResetCronService,
    FreePlanReconciliationCron,
    CleanupTaskCron,
    CreditReconciliationCron,
  ],
})
export class CronModule {}
