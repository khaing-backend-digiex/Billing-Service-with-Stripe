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
          await this.ensureStripeSetup(newAdmin);
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
    }

    // Self-healing: lần signup trước có thể fail giữa chừng (Stripe down) →
    // user tồn tại nhưng thiếu customer hoặc chưa có subscription local.
    // Mỗi lần gọi lại sẽ kiểm tra và setup bù (idempotent — ensureFreeSubscription
    // skip nếu customer đã có sub active). Lỗi chỉ log để không chặn login,
    // lần gọi sau tự retry.
    const hasSubscription =
      (await this.prisma.subscription.count({ where: { userId: user.id } })) > 0;
    if (!user.providerCustomerId || !hasSubscription) {
      try {
        await this.ensureStripeSetup(user);
      } catch (err) {
        this.logger.error(
          `Failed to set up Stripe for user ${user.id} – will retry on next call`,
          err,
        );
      }
    }
    return user;
  }

  /**
   * Idempotent: tạo Stripe customer nếu user chưa có, rồi đảm bảo có free
   * subscription. Gọi lại nhiều lần an toàn.
   */
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
