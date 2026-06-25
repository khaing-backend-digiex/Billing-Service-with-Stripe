import { IsString, IsNotEmpty, IsEmail, IsOptional } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class RegisterDto {
  @ApiProperty({ example: "john_doe" })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiProperty({ example: "securePassword123" })
  @IsString()
  @IsNotEmpty()
  password: string;

  @ApiProperty({ example: "John Doe" })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: "john@example.com" })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiPropertyOptional({ example: "1990-01-15" })
  @IsString()
  @IsOptional()
  dateOfBirth?: string;
}
