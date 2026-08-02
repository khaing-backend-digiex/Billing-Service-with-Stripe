import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, Min } from 'class-validator';

export class CreatePricingOptionDto {
  @ApiProperty({ description: 'The ID of the plan' })
  @IsString()
  planId!: string;

  @ApiProperty({ description: 'The ID of the billing cycle' })
  @IsString()
  billingCycleId!: string;

  @ApiProperty({ description: 'The name of this pricing option', example: 'Monthly Pro' })
  @IsString()
  name!: string;

  @ApiProperty({ description: 'Price in the specified currency', example: 19.99 })
  @IsNumber()
  @Min(0)
  price!: number;

  @ApiProperty({ description: 'The currency code (e.g., USD, VND)', example: 'USD' })
  @IsString()
  currency!: string;
}
