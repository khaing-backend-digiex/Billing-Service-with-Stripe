import { IsString, IsNotEmpty } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class LoginDto {
  @ApiProperty({ example: "user@example.com" })
  @IsString()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: "securePassword123" })
  @IsString()
  @IsNotEmpty()
  password: string;
}
