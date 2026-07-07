import {
  Injectable,
  NotFoundException,
  BadRequestException,
  forwardRef,
  Inject,
  OnApplicationBootstrap,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { StripeService } from "../stripe/stripe.service";
import { User } from "@prisma/client";

@Injectable()
export class UsersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(UsersService.name);
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => StripeService))
    private readonly stripeService: StripeService,
  ) { }

  async onApplicationBootstrap() {
    try {
      const adminExists = await this.prisma.user.findFirst({
        where: {
          roles: {
            has: "admin",
          },
        },
      });

      if (adminExists) {
        this.logger.log("Admin already exists");
        return;
      }
      const newAdmin = await this.prisma.user.create({
        data: {
          email: "[EMAIL_ADDRESS]",
          name: "Admin",
          roles: ["admin"],
        }
      })

      await this.ensureStripeSetup(newAdmin);
      this.logger.log(`Default admin created with email: ${newAdmin.email}`);
    }
    catch (err) {
      this.logger.error("Failed to create admin user on startup", err);
      throw err;
    }

  }
  async createUser(email: string, name?: string): Promise<User> {
    return this.prisma.user.create({
      data: {
        email,
        name: name ?? null,
        roles: ["user"],
      },
    });
  }

  async findOrCreateByEmail(
    email: string,
    name?: string,
  ): Promise<User> {
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return existingUser;
    }

    return this.createUser(email, name);
  }

 async initializeUser(user: User): Promise<void> {
  try {
    await this.ensureStripeSetup(user);
  } catch (error) {
    this.logger.error(
      `Failed to initialize user ${user.id}.`,
      error,
    );
    throw error;
  }
}

  private async ensureStripeSetup(user: User): Promise<void> {
    let customerId = user.providerCustomerId;
    if (!customerId) {
      const customer = await this.stripeService.createCustomer(
        user.id,
        user.email,
        user.name || undefined,
      );
      customerId = customer.id;
    }
    await this.stripeService.ensureFreeSubscription(customerId);
  }

  async findAll(limit: number = 10, offset: number = 0): Promise<User[]> {
    return this.prisma.user.findMany({
      take: Math.max(1, limit),
      skip: Math.max(0, offset),
      orderBy: { createdAt: "desc" },
    });
  }

  async findById(id: number): Promise<User> {
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
    return this.prisma.user.findFirst({ where: { providerCustomerId: stripeCustomerId } });
  }

  async updateStripeCustomerId(
    userId: number,
    stripeCustomerId: string,
  ): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { providerCustomerId: stripeCustomerId },
    });
  }

  async deleteUser(id: number): Promise<void> {
    await this.prisma.user.delete({ where: { id } });
  }
}
