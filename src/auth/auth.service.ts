import {
  BadRequestException,
  Injectable,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { UsersService } from "../users/users.service";
import { LoginDto } from "./dto/login.dto";
import { RegisterDto } from "./dto/register.dto";

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  async login(loginDto: LoginDto) {
    const user = await this.usersService.findByEmail(loginDto.email);

    if (!user) {
      throw new BadRequestException("User not found.");
    }

    const payload = {
      sub: user.id,
      email: user.email,
      roles: user.roles,
    };

    return {
      accessToken: this.jwtService.sign(payload),
      user: {
        email: user.email,
        name: user.name,
        roles: user.roles,
      },
    };
  }

  async register(registerDto: RegisterDto) {
    const { email, name } = registerDto;

    const existingUser = await this.usersService.findByEmail(email);

    if (existingUser) {
      throw new BadRequestException("Email already exists.");
    }

    const user = await this.usersService.createUser(email, name);

    return {
      name: user.name,
      email: user.email,
      roles: user.roles,
    };
  }
}
