import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, Min } from 'class-validator';

export class CreateAddonPackageDto {
  @ApiProperty({ description: 'The unique code for the addon', example: 'ADDON_50_CREDITS' })
  @IsString()
  code: string;

  @ApiProperty({ description: 'The name of the addon', example: '50 Extra Credits' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Number of credits provided by this addon', example: 50 })
  @IsNumber()
  @Min(1)
  credits: number;

  @ApiProperty({ description: 'Price of the addon', example: 4.99 })
  @IsNumber()
  @Min(0)
  price: number;

  @ApiProperty({ description: 'Currency code', example: 'USD' })
  @IsString()
  currency: string;
}
