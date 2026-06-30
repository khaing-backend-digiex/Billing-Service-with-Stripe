import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  HttpStatus,
  UseGuards,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse as SwaggerResponse,
} from "@nestjs/swagger";
import { UsersService } from "./users.service";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { Roles } from "../common/decorators/roles.decorator";
import { ApiResponse } from "../common/dto/api-response.dto";

import { Role } from "../common/constants/roles.enum";

@ApiTags("Users")
@ApiBearerAuth("JWT-auth")
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Get all users (Admin only)" })
  @SwaggerResponse({ status: 200, description: "Return all users" })
  async findAll() {
    const users = await this.usersService.findAll();
    return new ApiResponse(HttpStatus.OK, "Users fetched successfully", users);
  }

  @Get(":id")
  @Roles(Role.ADMIN, Role.USER)
  @ApiOperation({ summary: "Get user by ID" })
  @SwaggerResponse({ status: 200, description: "Return user data" })
  async findOne(@Param("id") id: string) {
    const user = await this.usersService.findById(+id);
    return new ApiResponse(HttpStatus.OK, "User fetched successfully", user);
  }

  @Delete(":id")
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Delete user (Admin only)" })
  @SwaggerResponse({ status: 200, description: "User deleted" })
  async remove(@Param("id") id: string) {
    await this.usersService.deleteUser(+id);
    return new ApiResponse(HttpStatus.OK, "User deleted successfully", null);
  }
}
