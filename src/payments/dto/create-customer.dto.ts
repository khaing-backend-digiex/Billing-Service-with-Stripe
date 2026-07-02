import { IsString, IsOptional, IsEmail } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

export class CreateCustomerDto {
  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  name?: string;
}
