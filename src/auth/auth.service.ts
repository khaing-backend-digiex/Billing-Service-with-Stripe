import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
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
    const { username, password } = loginDto;

    const user = await this.usersService.findByUsername(username);
    if (!user) {
      throw new UnauthorizedException("Invalid username or password");
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException("Invalid username or password");
    }

    const payload = {
      sub: user.id,
      username: user.username,
      roles: user.roles,
    };

    const accessToken = this.jwtService.sign(payload);

    return {
      accessToken,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
        roles: user.roles,
      },
    };
  }

  async register(registerDto: RegisterDto) {
    const existingUser = await this.usersService.findByUsername(
      registerDto.username,
    );
    if (existingUser) {
      throw new ConflictException("Username already exists");
    }

    const hashedPassword = await bcrypt.hash(registerDto.password, 10);

    const user = await this.usersService.create({
      username: registerDto.username,
      password: hashedPassword,
      name: registerDto.name,
      email: registerDto.email,
      dateOfBirth: registerDto.dateOfBirth
        ? new Date(registerDto.dateOfBirth)
        : undefined,
      roles: ["user"],
    });

    return {
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      dateOfBirth: user.dateOfBirth,
      roles: user.roles,
    };
  }
}
