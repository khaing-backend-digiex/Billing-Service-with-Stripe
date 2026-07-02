import { IsString, IsNotEmpty, IsOptional, IsIn } from "class-validator";

export class CreateCheckoutDto {
  @IsString()
  @IsNotEmpty()
  priceId: string;

  @IsOptional()
  @IsString()
  @IsIn(["payment", "subscription"])
  mode?: "payment" | "subscription";
}

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
