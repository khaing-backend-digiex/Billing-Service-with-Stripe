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
  ) {}

  async onApplicationBootstrap() {
    try {
      const adminExists = await this.prisma.user.findFirst({
        where: {
          roles: {
            has: "admin",
          },
        },
      });

      if (!adminExists) {
        this.logger.log("Admin user not found. Creating default admin...");
        const newAdmin = await this.prisma.user.create({
          data: {
            email: "admin@example.com",
            name: "Super Admin",
            roles: ["admin", "user"],
          },
        });
        
        try {
          const customer = await this.stripeService.createCustomer(
            newAdmin.id,
            newAdmin.email,
            newAdmin.name || undefined,
          );
          await this.stripeService.subscribeToFreePlan(customer.id);
        } catch (err) {
          this.logger.error("Failed to create stripe customer for admin", err);
        }

        this.logger.log(`Default admin created with email: ${newAdmin.email}`);
      } else {
        this.logger.log("Admin user already exists.");
      }
    } catch (error) {
      this.logger.error("Failed to seed admin user on startup", error);
    }
  }

  async findOrCreateByEmail(email: string, name?: string): Promise<User> {
    let user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email,
          name: name || null,
          roles: ["user"],
        },
      });

      // Create Stripe Customer
      try {
        const customer = await this.stripeService.createCustomer(
          user.id,
          user.email,
          user.name || undefined,
        );
        
        await this.stripeService.subscribeToFreePlan(customer.id);
      } catch (err) {
        console.error("Failed to create stripe customer or free plan", err);
      }
    }
    return user;
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
