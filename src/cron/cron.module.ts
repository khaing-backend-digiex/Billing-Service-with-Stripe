import { Module } from "@nestjs/common";
import { StripeModule } from "../stripe/stripe.module";
import { CreditResetCronService } from "./credit-reset.cron";
import { FreePlanReconciliationCron } from "./free-plan-reconciliation.cron";

@Module({
  imports: [StripeModule],
  providers: [CreditResetCronService, FreePlanReconciliationCron],
})
export class CronModule {}
