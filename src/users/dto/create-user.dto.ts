import {
  IsString,
  IsNotEmpty,
  IsEmail,
  IsOptional,
  IsArray,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateUserDto {
  @ApiProperty({ example: "jane_doe" })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiProperty({ example: "securePassword123" })
  @IsString()
  @IsNotEmpty()
  password: string;

  @ApiProperty({ example: "Jane Doe" })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: "jane@example.com" })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiPropertyOptional({ example: "1992-05-20" })
  @IsString()
  @IsOptional()
  dateOfBirth?: string;

  @ApiPropertyOptional({
    example: ["user"],
    description: "Roles to assign (admin, manager, user)",
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  roles?: string[];
}
