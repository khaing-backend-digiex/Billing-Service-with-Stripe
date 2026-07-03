import { Module } from "@nestjs/common";
import { CreditResetCronService } from "./credit-reset.cron";

@Module({
  providers: [CreditResetCronService],
})
export class CronModule {}
