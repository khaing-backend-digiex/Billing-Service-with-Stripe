import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  HttpStatus,
  UseGuards,
  Query,
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
import { PaginationQueryDto } from "../common/dto/pagination-query.dto";

import { GetUser } from "../common/decorators/get-user.decorator";
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
  async findAll(@Query() query: PaginationQueryDto) {
    const { page = 1, limit = 10 } = query;
    const offset = (page - 1) * limit;

    const data = await this.usersService.findAll(limit, offset);
    return new ApiResponse(HttpStatus.OK, "Users fetched successfully", data);
  }

  @Get("me/dashboard")
  @Roles(Role.ADMIN, Role.USER)
  @ApiOperation({ summary: "Get user dashboard data" })
  async getDashboardData(@GetUser("id") userId: string) {
    const data = await this.usersService.getDashboardData(userId);
    return new ApiResponse(HttpStatus.OK, "Dashboard data fetched successfully", data);
  }

  @Get(":id")
  @Roles(Role.ADMIN, Role.USER)
  @ApiOperation({ summary: "Get user by ID" })
  @SwaggerResponse({ status: 200, description: "Return user data" })
  async findOne(@Param("id") id: string) {
    const user = await this.usersService.findById(id);
    return new ApiResponse(HttpStatus.OK, "User fetched successfully", user);
  }

  @Delete(":id")
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Delete user (Admin only)" })
  @SwaggerResponse({ status: 200, description: "User deleted" })
  async remove(@Param("id") id: string) {
    await this.usersService.deleteUser(id);
    return new ApiResponse(HttpStatus.OK, "User deleted successfully", null);
  }
}
