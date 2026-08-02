import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, Min } from 'class-validator';

export class CreatePlanDto {
  @ApiProperty({ description: 'The unique code for the plan', example: 'PRO' })
  @IsString()
  code!: string;

  @ApiProperty({ description: 'The name of the plan', example: 'Pro Plan' })
  @IsString()
  name!: string;

  @ApiProperty({ description: 'Credits given upon renewal', example: 100 })
  @IsNumber()
  @Min(0)
  renewalCredits!: number;

  @ApiProperty({ description: 'Reset interval in days', example: 30 })
  @IsNumber()
  @Min(1)
  resetIntervalDay!: number;
}
