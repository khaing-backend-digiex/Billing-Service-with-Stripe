import { Controller, Post, Body, HttpCode, HttpStatus } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse as SwaggerResponse,
} from "@nestjs/swagger";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { RegisterDto } from "./dto/register.dto";
import { Public } from "../common/decorators/public.decorator";
import { ApiResponse } from "../common/dto/api-response.dto";

@ApiTags("Auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "User login" })
  @SwaggerResponse({ status: 200, description: "Login successful" })
  @SwaggerResponse({ status: 401, description: "Invalid credentials" })
  async login(@Body() loginDto: LoginDto) {
    const result = await this.authService.login(loginDto);
    return new ApiResponse(
      HttpStatus.OK,
      "User logged in successfully",
      result,
    );
  }

  @Public()
  @Post("register")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "User registration" })
  @SwaggerResponse({ status: 201, description: "Registration successful" })
  @SwaggerResponse({ status: 409, description: "User already exists" })
  async register(@Body() registerDto: RegisterDto) {
    const result = await this.authService.register(registerDto);
    return new ApiResponse(
      HttpStatus.CREATED,
      "User registered successfully",
      result,
    );
  }
}
