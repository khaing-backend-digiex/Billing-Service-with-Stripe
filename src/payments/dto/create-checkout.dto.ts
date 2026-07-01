import { IsString, IsNotEmpty } from "class-validator";

export class CreateSubscriptionCheckoutDto {
  @IsString()
  @IsNotEmpty()
  pricingOptionId: string;
}

export class CreateAddonCheckoutDto {
  @IsString()
  @IsNotEmpty()
  addonPackageId: string;
}
