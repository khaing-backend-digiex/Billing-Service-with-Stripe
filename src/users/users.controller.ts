import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpStatus,
  ParseIntPipe,
  UseGuards,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse as SwaggerResponse,
  ApiQuery,
} from "@nestjs/swagger";
import { UsersService } from "./users.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { ApiResponse } from "../common/dto/api-response.dto";
import { Roles } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { Role } from "../common/constants/roles.enum";

@ApiTags("Users")
@ApiBearerAuth("JWT-auth")
@Controller("users")
@UseGuards(RolesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: "Create a new user" })
  @SwaggerResponse({ status: 201, description: "User created successfully" })
  async create(@Body() createUserDto: CreateUserDto) {
    const user = await this.usersService.createUser(createUserDto);
    return new ApiResponse(
      HttpStatus.CREATED,
      "User created successfully",
      user,
    );
  }

  @Get()
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: "Get all users" })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiQuery({ name: "offset", required: false, type: Number })
  async findAll(
    @Query("limit") limit: number = 10,
    @Query("offset") offset: number = 0,
  ) {
    const users = await this.usersService.findAll(limit, offset);
    return new ApiResponse(HttpStatus.OK, "Users fetched successfully", users);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get user by ID" })
  async findOne(@Param("id", ParseIntPipe) id: number) {
    const user = await this.usersService.findById(id);
    return new ApiResponse(HttpStatus.OK, "User fetched successfully", user);
  }

  @Put(":id")
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: "Update a user" })
  async update(
    @Param("id", ParseIntPipe) id: number,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    const user = await this.usersService.updateUser(id, updateUserDto);
    return new ApiResponse(HttpStatus.OK, "User updated successfully", user);
  }

  @Delete(":id")
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Delete a user" })
  async remove(@Param("id", ParseIntPipe) id: number) {
    await this.usersService.deleteUser(id);
    return new ApiResponse(HttpStatus.OK, "User deleted successfully", null);
  }
}
