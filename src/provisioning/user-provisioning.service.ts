import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { StripeService } from "../stripe/stripe.service";
import { UsersService } from "../users/users.service";
import { User } from "@prisma/client";

export type PublicUser = Pick<User, "email" | "name" | "roles">;

const toPublicUser = (user: User): PublicUser => ({
  email: user.email,
  name: user.name,
  roles: user.roles,
});

@Injectable()
export class UserProvisioningService implements OnApplicationBootstrap {
  private readonly logger = new Logger(UserProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly usersService: UsersService,
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

  private async provisionUser(data: {
    email: string;
    name?: string;
    roles?: string[];
  }): Promise<User> {
    const newUser = await this.usersService.createUserRecord(data);

    try {
      await this.initializeUser(newUser);
      return newUser;
    } catch (error) {
      await this.rollbackProvisionedUser(newUser.id);
      throw error;
    }
  }

  private async initializeUser(user: User): Promise<void> {
    try {
      await this.ensureStripeSetup(user);
    } catch (error) {
      this.logger.error(`Failed to initialize user ${user.id}.`, error);
      throw error;
    }
  }

  private async ensureStripeSetup(user: User): Promise<void> {
    const customerId = await this.stripeService.ensureCustomerId(user);
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

  private async rollbackProvisionedUser(userId: number): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { providerCustomerId: true },
      });

      if (user?.providerCustomerId) {
        await this.stripeService.cleanupCustomer(user.providerCustomerId);
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

  
}
