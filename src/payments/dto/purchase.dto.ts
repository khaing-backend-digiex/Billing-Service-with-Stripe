import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class PurchaseSubscriptionDto {
  @ApiProperty({ description: "Id of the PricingOption to subscribe to" })
  @IsString()
  @IsNotEmpty()
  pricingOptionId!: string;
}

export class PurchaseAddonDto {
  @ApiProperty({ description: "Id of the AddonPackage to buy" })
  @IsString()
  @IsNotEmpty()
  addonPackageId!: string;
}
