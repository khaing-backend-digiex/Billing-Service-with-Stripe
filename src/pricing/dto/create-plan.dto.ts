import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, Min, IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { ResetInterval } from '@prisma/client';

export class CreatePlanDto {
  @ApiProperty({ description: 'The ID of the product' })
  @IsString()
  productId!: string;

  @ApiProperty({ description: 'The unique code for the plan', example: 'PRO' })
  @IsString()
  code!: string;

  @ApiProperty({ description: 'The name of the plan', example: 'Pro Plan' })
  @IsString()
  name!: string;

  @ApiProperty({ description: 'Whether this is a free plan', example: false, required: false })
  @IsOptional()
  @IsBoolean()
  isFree?: boolean;

  @ApiProperty({ description: 'Credits given upon renewal', example: 100 })
  @IsNumber()
  @Min(0)
  creditAmount!: number;

  @ApiProperty({ description: 'Reset interval type (MONTHLY or EVERY_N_DAYS)', enum: ResetInterval })
  @IsEnum(ResetInterval)
  resetInterval!: ResetInterval;

  @ApiProperty({ description: 'Interval in days if EVERY_N_DAYS', required: false })
  @IsOptional()
  @IsNumber()
  @Min(1)
  intervalDays?: number;
}
