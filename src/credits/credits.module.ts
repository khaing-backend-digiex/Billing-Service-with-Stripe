import { Module } from "@nestjs/common";
import { CreditResetService } from "./credit-reset.service";

@Module({
  providers: [CreditResetService],
})
export class CreditsModule {}
