import { IsString, IsNotEmpty } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class LoginDto {
  @ApiProperty({ example: "admin_user" })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiProperty({ example: "password123" })
  @IsString()
  @IsNotEmpty()
  password: string;
}
