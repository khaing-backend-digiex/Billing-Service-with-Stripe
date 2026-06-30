import { IsString, IsNotEmpty, IsOptional, IsIn } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateCheckoutDto {
  @IsString()
  @IsNotEmpty()
  priceId: string;

  @IsOptional()
  @IsIn(["payment", "subscription"])
  mode?: "payment" | "subscription" = "payment";
}
