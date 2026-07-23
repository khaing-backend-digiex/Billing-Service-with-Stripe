import {
  Injectable,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { User, SubscriptionStatus } from "@prisma/client";
import { randomUUID } from "crypto";
import { isAddonUsable } from "../credits/credit.types";

const LIVE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
];

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  constructor(
    private readonly prisma: PrismaService,
  ) { }

  async createUserRecord(data: {
    email: string;
    password: string;
    name?: string;
    roles?: string[];
  }): Promise<User> {
    return this.prisma.user.create({
      data: {
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
        OR: [
          { providerCustomerId: null },
          { subscriptions: { none: { status: { in: LIVE_STATUSES } } } },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: params.limit,
    });
  }

  async findAll(limit: number = 10, offset: number = 0) {
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        take: Math.max(1, limit),
        skip: Math.max(0, offset),
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          email: true,
          name: true,
          roles: true,
          dateOfBirth: true,
          provider: true,
          providerCustomerId: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.user.count(),
    ]);

    return { users, total };
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

  async getDashboardData(userId: string) {
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        pricingOption: {
          include: {
            plan: {
              include: {
                creditPolicy: true,
              }
            },
            billingCycle: true,
          }
        }
      }
    });

    const grants = await this.prisma.creditGrant.findMany({
      where: {
        userId,
        OR: [
          { 
            expiresAt: null,
            amountRemaining: { gt: 0 }
          },
          { 
            expiresAt: { gt: new Date() } 
          }
        ]
      },
      orderBy: { expiresAt: 'asc' }
    });

    const addonUsable = isAddonUsable(
      subscription?.pricingOption?.plan?.isFree,
      subscription?.status
    );

    const balance = grants.reduce((sum, g) => {
      if (g.sourceType === 'ADDON' && !addonUsable) {
        return sum;
      }
      return sum + g.amountRemaining;
    }, 0);
    const txCount = await this.prisma.creditTransaction.count({ where: { userId } });

    return {
      subscription: subscription ? {
        id: subscription.id,
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        nextCreditResetAt: subscription.currentPeriodEnd,
        autoRenew: subscription.autoRenew,
        cancelledAt: subscription.cancelledAt,
        plan: subscription.pricingOption?.plan || null,
        pricingOption: subscription.pricingOption || null,
      } : null,
      credits: {
        balance,
        grants,
        isSetup: txCount > 0,
      }
    };
  }
}
