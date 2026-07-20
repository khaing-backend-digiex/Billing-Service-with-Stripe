import { Module } from "@nestjs/common";
import { UserProvisioningService } from "./user-provisioning.service";
import { UsersModule } from "../users/users.module";
import { StripeModule } from "../stripe/stripe.module";
import { CreditsModule } from "../credits/credits.module";

@Module({
  imports: [UsersModule, StripeModule, CreditsModule],
  providers: [UserProvisioningService],
  exports: [UserProvisioningService],
})
export class ProvisioningModule {}
