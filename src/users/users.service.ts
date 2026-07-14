import {
  Injectable,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { User } from "@prisma/client";
import { randomUUID } from "crypto";

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async createUserRecord(data: {
    email: string;
    password: string;
    name?: string;
    roles?: string[];
  }): Promise<User> {
    return this.prisma.user.create({
      data: {
        id: randomUUID(),
        email: data.email,
        password: data.password,
        name: data.name,
        roles: data.roles,
      },
    });
  }

  async findIncompleteOnboardingUsers(params: {
    createdBefore: Date;
    limit: number;
  }): Promise<User[]> {
    return this.prisma.user.findMany({
      where: {
        createdAt: { lt: params.createdBefore },
        OR: [{ providerCustomerId: null }, { subscription: null }],
      },
      orderBy: { createdAt: "asc" },
      take: params.limit,
    });
  }

  async findAll(limit: number = 10, offset: number = 0): Promise<User[]> {
    return this.prisma.user.findMany({
      take: Math.max(1, limit),
      skip: Math.max(0, offset),
      orderBy: { createdAt: "desc" },
    });
  }

  async findById(id: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException("User not found");
    }
    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async findByStripeCustomerId(stripeCustomerId: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: { providerCustomerId: stripeCustomerId },
    });
  }

  async updateStripeCustomerId(
    userId: string,
    stripeCustomerId: string,
  ): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { providerCustomerId: stripeCustomerId },
    });
  }

  async deleteUser(id: string): Promise<void> {
    await this.prisma.user.delete({ where: { id } });
  }
}
