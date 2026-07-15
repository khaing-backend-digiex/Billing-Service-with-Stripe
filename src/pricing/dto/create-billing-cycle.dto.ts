import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, Min } from 'class-validator';

export class CreateBillingCycleDto {
  @ApiProperty({ description: 'The name of the billing cycle', example: 'Monthly' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Duration in days', example: 30 })
  @IsNumber()
  @Min(1)
  durationDay: number;
}
