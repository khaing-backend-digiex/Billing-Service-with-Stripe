import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ResetInterval } from '@prisma/client';

export class CreditPolicyDto {
  @ApiProperty({ description: 'Credits granted each reset period', example: 100 })
  @IsNumber()
  @Min(0)
  creditAmount: number;

  @ApiProperty({
    description: 'How often credits reset',
    enum: ResetInterval,
    example: ResetInterval.MONTHLY,
  })
  @IsEnum(ResetInterval)
  resetInterval: ResetInterval;

  @ApiPropertyOptional({
    description: 'Required when resetInterval is EVERY_N_DAYS',
    example: 45,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  intervalDays?: number;
}

export class CreatePlanDto {
  @ApiProperty({ description: 'The ID of the product this plan belongs to' })
  @IsString()
  productId: string;

  @ApiProperty({ description: 'Plan code, unique within the product', example: 'PRO' })
  @IsString()
  code: string;

  @ApiProperty({ description: 'The name of the plan', example: 'Pro Plan' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ description: 'Whether this is the free tier of the product' })
  @IsOptional()
  @IsBoolean()
  isFree?: boolean;

  @ApiProperty({ description: 'Credit entitlement policy for this plan', type: CreditPolicyDto })
  @ValidateNested()
  @Type(() => CreditPolicyDto)
  creditPolicy: CreditPolicyDto;
}
