import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  forwardRef,
  Inject,
  OnApplicationBootstrap,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { StripeService } from "../stripe/stripe.service";
import { User } from "@prisma/client";

export type PublicUser = Pick<User, "email" | "name" | "roles">;

type StripeCustomerOwner = {
  id: number;
  email: string;
  name?: string | null;
  providerCustomerId?: string | null;
};

const toPublicUser = (user: User): PublicUser => ({
  email: user.email,
  name: user.name,
  roles: user.roles,
});

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

      if (adminExists) {
        this.logger.log("Admin already exists");
        return;
      }
      const newAdmin = await this.provisionUser({
        email: "[EMAIL_ADDRESS]",
        name: "Admin",
        roles: ["admin"],
      });

      this.logger.log(`Default admin created with email: ${newAdmin.email}`);
    } catch (err) {
      this.logger.error("Failed to create admin user on startup", err);
      throw err;
    }
  }
  async createUser(email: string, name?: string): Promise<PublicUser> {
    const newUser = await this.provisionUser({
      email,
      name,
    });
    return toPublicUser(newUser);
  }

  async ensureStripeCustomerId(user: StripeCustomerOwner): Promise<string> {
    if (user.providerCustomerId) {
      return user.providerCustomerId;
    }

    return this.createAndPersistStripeCustomer(user);
  }

  async ensureValidStripeCustomerId(user: StripeCustomerOwner): Promise<string> {
    if (!user.providerCustomerId) {
      return this.createAndPersistStripeCustomer(user);
    }

    if (await this.stripeService.customerExists(user.providerCustomerId)) {
      return user.providerCustomerId;
    }

    this.logger.warn(
      `Stripe customer ${user.providerCustomerId} of user ${user.id} no longer exists – re-provisioning`,
    );
    return this.createAndPersistStripeCustomer(user);
  }

  private async createAndPersistStripeCustomer(
    user: StripeCustomerOwner,
  ): Promise<string> {
    const customer = await this.stripeService.createCustomer(
      user.id,
      user.email,
      user.name || undefined,
    );

    try {
      await this.updateStripeCustomerId(user.id, customer.id);
      return customer.id;
    } catch (error) {
      await this.cleanupStripeCustomer(customer.id);
      throw error;
    }
  }

  private async cleanupStripeCustomer(customerId: string): Promise<void> {
    try {
      await this.stripeService.deleteCustomer(customerId);
    } catch (deleteError) {
      this.logger.warn(
        `Failed to clean up Stripe customer ${customerId} after DB update failure: ${deleteError}`,
      );
      await this.enqueueStripeCustomerCleanup(customerId);
    }
  }

  private async enqueueStripeCustomerCleanup(customerId: string): Promise<void> {
    try {
      await this.prisma.cleanupTask.upsert({
        where: { type_target: { type: "STRIPE_CUSTOMER", target: customerId } },
        create: { type: "STRIPE_CUSTOMER", target: customerId },
        update: { status: "PENDING", attempts: 0 },
      });
      this.logger.warn(`Queued cleanup for orphan Stripe customer ${customerId}`);
    } catch (error) {
      this.logger.error(
        `Failed to queue cleanup for Stripe customer ${customerId}: ${error}`,
      );
    }
  }

  private async provisionUser(data: {
    email: string;
    name?: string;
    roles?: string[];
  }): Promise<User> {
    const newUser = await this.prisma.user.create({
      data: {
        email: data.email,
        name: data.name,
        roles: data.roles,
      },
    });

    try {
      await this.initializeUser(newUser);
      return newUser;
    } catch (error) {
      await this.rollbackProvisionedUser(newUser.id);
      throw error;
    }
  }

  private async rollbackProvisionedUser(userId: number): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { providerCustomerId: true },
      });

      if (user?.providerCustomerId) {
        try {
          await this.stripeService.deleteCustomer(user.providerCustomerId);
        } catch (error) {
          this.logger.warn(
            `Failed to rollback Stripe customer for user ${userId}: ${error}`,
          );
          await this.enqueueStripeCustomerCleanup(user.providerCustomerId);
        }
      }

      try {
        await this.prisma.user.delete({ where: { id: userId } });
      } catch (error) {
        this.logger.warn(
          `Failed to rollback database user ${userId}: ${error}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to prepare rollback for user ${userId}: ${error}`,
      );
    }
  }

  async initializeUser(user: User): Promise<void> {
    try {
      await this.ensureStripeSetup(user);
    } catch (error) {
      this.logger.error(`Failed to initialize user ${user.id}.`, error);
      throw error;
    }
  }

  private async ensureStripeSetup(user: User): Promise<void> {
    const customerId = await this.ensureStripeCustomerId(user);
    try {
      await this.stripeService.ensureFreeSubscription(customerId);
    } catch (error) {
      this.logger.error(
        `Failed to register free plan for user ${user.id} with Stripe customer ${customerId}`,
        error,
      );
      throw new InternalServerErrorException(
        `Failed to register free plan for user ${user.id}`,
      );
    }
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
    return this.prisma.user.findFirst({
      where: { providerCustomerId: stripeCustomerId },
    });
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
