import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as bcrypt from "bcrypt";
import { User } from "../database/entities/user.entity";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async create(data: Partial<User>): Promise<User> {
    const user = this.userRepository.create(data);
    return this.userRepository.save(user);
  }

  async createUser(dto: CreateUserDto): Promise<User> {
    const existing = await this.findByUsername(dto.username);
    if (existing) {
      throw new BadRequestException("Username already exists");
    }

    const existingEmail = await this.userRepository.findOne({
      where: { email: dto.email },
    });
    if (existingEmail) {
      throw new BadRequestException("Email already exists");
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const user = this.userRepository.create({
      ...dto,
      password: hashedPassword,
      dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
      roles: dto.roles || ["user"],
    });

    const savedUser = await this.userRepository.save(user);
    return this.sanitizeUser(savedUser);
  }

  async findAll(limit: number = 10, offset: number = 0): Promise<User[]> {
    const users = await this.userRepository.find({
      take: Math.max(1, limit),
      skip: Math.max(0, offset),
      order: { createdAt: "DESC" },
    });

    return users.map((user) => this.sanitizeUser(user));
  }

  async findById(id: number): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException("User not found");
    }
    return user;
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { username } });
  }

  async findByStripeCustomerId(stripeCustomerId: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { stripeCustomerId } });
  }

  async updateUser(id: number, dto: UpdateUserDto): Promise<User> {
    const user = await this.findById(id);

    if (dto.password) {
      dto.password = await bcrypt.hash(dto.password, 10);
    }

    Object.assign(user, dto);

    if (dto.dateOfBirth) {
      user.dateOfBirth = new Date(dto.dateOfBirth);
    }

    const savedUser = await this.userRepository.save(user);
    return this.sanitizeUser(savedUser);
  }

  async updateStripeCustomerId(
    userId: number,
    stripeCustomerId: string,
  ): Promise<User> {
    const user = await this.findById(userId);
    user.stripeCustomerId = stripeCustomerId;
    return this.userRepository.save(user);
  }

  async deleteUser(id: number): Promise<void> {
    const user = await this.findById(id);
    await this.userRepository.remove(user);
  }

  private sanitizeUser(user: User): User {
    const { password, ...sanitized } = user;
    return sanitized as User;
  }
}
