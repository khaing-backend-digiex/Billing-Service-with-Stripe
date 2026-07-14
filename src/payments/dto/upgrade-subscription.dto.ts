import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsString, IsOptional, IsEnum } from "class-validator";
import { PaymentProvider } from "@prisma/client";

export class UpgradeSubscriptionDto {
  @ApiProperty({ description: "The ID of the new pricing option to upgrade to" })
  @IsNotEmpty()
  @IsString()
  pricingOptionId: string;

  @ApiPropertyOptional({ enum: PaymentProvider, default: PaymentProvider.STRIPE })
  @IsOptional()
  @IsEnum(PaymentProvider)
  provider?: PaymentProvider;
  
}
