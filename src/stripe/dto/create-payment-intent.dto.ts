import {
  IsNumber,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreatePaymentIntentDto {
  @IsNumber()
  @IsNotEmpty()
  @Min(50, { message: "Minimum amount is 50 cents" })
  amount: number;

  @IsString()
  @IsOptional()
  currency?: string = "usd";

  @IsString()
  @IsOptional()
  description?: string;
}
