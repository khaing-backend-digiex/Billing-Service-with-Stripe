import { Module } from "@nestjs/common";
import { UserProvisioningService } from "./user-provisioning.service";
import { UsersModule } from "../users/users.module";
import { StripeModule } from "../stripe/stripe.module";

@Module({
  imports: [UsersModule, StripeModule],
  providers: [UserProvisioningService],
  exports: [UserProvisioningService],
})
export class ProvisioningModule {}
