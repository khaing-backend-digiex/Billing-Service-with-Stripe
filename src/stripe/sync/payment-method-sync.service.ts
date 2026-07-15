import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PaymentMethod, PaymentProvider } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { PaymentMethodDetails } from "../../payments/types/payment.types";
import { StripeService } from "../stripe.service";

@Injectable()
export class PaymentMethodSyncService {
  private readonly logger = new Logger(PaymentMethodSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
  ) {}

  async syncAttached(details: PaymentMethodDetails): Promise<void> {
    if (!details.customerId) {
      this.logger.error(`Payment method ${details.id} has no customer – skipping`);
      return;
    }

    const user = await this.prisma.user.findFirst({
      where: { providerCustomerId: details.customerId },
      select: { id: true },
    });

    if (!user) {
      this.logger.error(`No user found for Stripe customer ${details.customerId}`);
      return;
    }

    const card = {
      brand: details.brand,
      last4: details.last4,
      expMonth: details.expMonth,
      expYear: details.expYear,
      fingerprint: details.fingerprint,
    };

    await this.prisma.paymentMethod.upsert({
      where: { providerPaymentMethodId: details.id },
      create: {
        userId: user.id,
        provider: PaymentProvider.STRIPE,
        providerPaymentMethodId: details.id,
        ...card,
      },
      update: card,
    });

    await this.syncDefault(user.id, details.customerId);
    this.logger.log(`Payment method ${details.id} synced for user ${user.id}`);
  }

  async syncDetached(paymentMethodId: string): Promise<void> {
    // Event `payment_method.detached` give customer = null
    const existing = await this.prisma.paymentMethod.findUnique({
      where: { providerPaymentMethodId: paymentMethodId },
      include: { user: { select: { id: true, providerCustomerId: true } } },
    });

    if (!existing) {
      this.logger.log(`Payment method ${paymentMethodId} not found locally – nothing to detach`);
      return;
    }

    await this.prisma.paymentMethod.delete({
      where: { providerPaymentMethodId: paymentMethodId },
    });

    if (existing.user.providerCustomerId) {
      await this.syncDefault(existing.user.id, existing.user.providerCustomerId);
    }

    this.logger.log(`Payment method ${paymentMethodId} removed for user ${existing.user.id}`);
  }

  async syncDefaultByCustomer(customerId: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { providerCustomerId: customerId },
      select: { id: true },
    });

    if (!user) {
      this.logger.error(`No user found for Stripe customer ${customerId}`);
      return;
    }

    await this.syncDefault(user.id, customerId);
  }

  async syncDefault(userId: string, customerId: string): Promise<void> {
    const defaultPaymentMethodId =
      await this.stripeService.getDefaultPaymentMethodId(customerId);

    await this.prisma.$transaction([
      this.prisma.paymentMethod.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      }),
      ...(defaultPaymentMethodId
        ? [
            this.prisma.paymentMethod.updateMany({
              where: { userId, providerPaymentMethodId: defaultPaymentMethodId },
              data: { isDefault: true },
            }),
          ]
        : []),
    ]);
  }

  async getDefaultOrThrow(userId: string, customerId: string): Promise<PaymentMethod> {
    const paymentMethod = await this.getDefaultForUser(userId, customerId);

    if (!paymentMethod) {
      throw new BadRequestException(
        "No default payment method. Add a card before making a purchase.",
      );
    }

    if (this.isExpired(paymentMethod)) {
      throw new BadRequestException(
        "Your default card has expired. Add a new card before making a purchase.",
      );
    }

    return paymentMethod;
  }

  isExpired(paymentMethod: PaymentMethod): boolean {
    if (!paymentMethod.expMonth || !paymentMethod.expYear) return false;

    const expiresAt = new Date(paymentMethod.expYear, paymentMethod.expMonth, 1);
    return expiresAt <= new Date();
  }

  async getDefaultForUser(
    userId: string,
    customerId: string,
  ): Promise<PaymentMethod | null> {
    const local = await this.prisma.paymentMethod.findFirst({
      where: { userId, isDefault: true },
    });
    if (local) return local;

    const hasAny = await this.prisma.paymentMethod.count({ where: { userId } });
    if (hasAny > 0) return null;

    return this.backfillFromStripe(userId, customerId);
  }
  /* Healing */
  private async backfillFromStripe(
    userId: string,
    customerId: string,
  ): Promise<PaymentMethod | null> {
    const paymentMethods = await this.stripeService.listPaymentMethods(customerId);
    if (paymentMethods.length === 0) return null;

    this.logger.warn(
      `User ${userId} has ${paymentMethods.length} card(s) on Stripe but none locally – backfilling`,
    );

    for (const details of paymentMethods) {
      await this.syncAttached({ ...details, customerId });
    }

    const defaultPaymentMethodId =
      await this.stripeService.getDefaultPaymentMethodId(customerId);

    if (!defaultPaymentMethodId) {
      await this.stripeService.setDefaultPaymentMethod(customerId, paymentMethods[0].id);
      await this.syncDefault(userId, customerId);
    }

    return this.prisma.paymentMethod.findFirst({ where: { userId, isDefault: true } });
  }
}
