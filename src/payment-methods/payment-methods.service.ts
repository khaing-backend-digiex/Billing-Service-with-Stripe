import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PaymentMethod, SubscriptionStatus } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { StripeService } from "../stripe/stripe.service";
import { PaymentMethodSyncService } from "../stripe/sync/payment-method-sync.service";
import { SetupIntentResult } from "../payments/types/payment.types";
import { PLAN_CODES } from "../common/constants/plan.constants";
import { UsersService } from "../users/users.service";

const LIVE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.PAST_DUE,
];

@Injectable()
export class PaymentMethodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly stripeService: StripeService,
    private readonly paymentMethodSync: PaymentMethodSyncService,
  ) {}

  async createSetupIntent(userId: string): Promise<SetupIntentResult> {
    const user = await this.usersService.findById(userId);
    const customerId = await this.stripeService.ensureValidCustomerId(user);
    return this.stripeService.createSetupIntent(customerId);
  }

  async list(userId: string): Promise<PaymentMethod[]> {
    const user = await this.usersService.findById(userId);

    if (user.providerCustomerId) {
      await this.paymentMethodSync.getDefaultForUser(userId, user.providerCustomerId);
    }

    return this.prisma.paymentMethod.findMany({
      where: { userId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    });
  }

  async setDefault(userId: string, paymentMethodId: string): Promise<void> {
    const paymentMethod = await this.findOwned(userId, paymentMethodId);

    if (this.paymentMethodSync.isExpired(paymentMethod)) {
      throw new BadRequestException(
        "This card has expired. Add a new card instead of setting it as default.",
      );
    }

    const user = await this.usersService.findById(userId);
    const customerId = await this.stripeService.ensureValidCustomerId(user);

    await this.stripeService.setDefaultPaymentMethod(
      customerId,
      paymentMethod.providerPaymentMethodId,
    );
    await this.paymentMethodSync.syncDefault(userId, customerId);
  }

  async remove(userId: string, paymentMethodId: string): Promise<void> {
    const paymentMethod = await this.findOwned(userId, paymentMethodId);

    if (paymentMethod.isDefault && (await this.hasLivePaidSubscription(userId))) {
      throw new BadRequestException(
        "This is the default card of an active paid subscription. " +
          "Set another card as default before removing it.",
      );
    }

    await this.stripeService.detachPaymentMethod(paymentMethod.providerPaymentMethodId);
    await this.paymentMethodSync.syncDetached(paymentMethod.providerPaymentMethodId);
  }

  private async findOwned(userId: string, id: string): Promise<PaymentMethod> {
    const paymentMethod = await this.prisma.paymentMethod.findFirst({
      where: { id, userId },
    });

    if (!paymentMethod) {
      throw new NotFoundException("Payment method not found");
    }

    return paymentMethod;
  }

  private async hasLivePaidSubscription(userId: string): Promise<boolean> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { 
        userId,
        status: { in: LIVE_STATUSES },
        pricingOption: {
          plan: {
            isFree: false,
          }
        }
      },
    });

    return !!subscription;
  }

}
