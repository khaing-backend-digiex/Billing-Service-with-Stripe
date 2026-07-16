import { Injectable, Inject, Logger, BadRequestException } from "@nestjs/common";
import { IPaymentAdapter } from "../payments/types/payment-adapter.interface";
import {
  PaymentCustomer,
  PaymentSubscription,
  PaymentInvoice,
  PaymentMethodDetails,
  SetupIntentResult,
  OffSessionPaymentResult,
  OffSessionSubscriptionResult,
  BillingPortalSession,
  WebhookEvent,
} from "../payments/types/payment.types";
import { PrismaService } from "../database/prisma.service";
import { AddonPackage, SubscriptionStatus } from "@prisma/client";
import { PLAN_CODES } from "../common/constants/plan.constants";
import { STRIPE_METADATA_KEY } from "../common/constants/stripe.constants";
import { formatDatabaseAmountToStripe } from "./utils/stripe-currency.util";

type StripeCustomerOwner = {
  id: string;
  email: string;
  name?: string | null;
  providerCustomerId?: string | null;
};

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);

  constructor(
    @Inject("PAYMENT_ADAPTER")
    private readonly paymentAdapter: IPaymentAdapter,
    private readonly prisma: PrismaService,
  ) {}

  async ensureCustomerId(user: StripeCustomerOwner): Promise<string> {
    if (user.providerCustomerId) {
      return user.providerCustomerId;
    }

    return this.createAndPersistCustomer(user);
  }

  async ensureValidCustomerId(user: StripeCustomerOwner): Promise<string> {
    if (!user.providerCustomerId) {
      return this.createAndPersistCustomer(user);
    }

    if (await this.customerExists(user.providerCustomerId)) {
      return user.providerCustomerId;
    }

    this.logger.warn(
      `Stripe customer ${user.providerCustomerId} of user ${user.id} no longer exists – re-provisioning`,
    );
    return this.createAndPersistCustomer(user);
  }

  private async createAndPersistCustomer(
    user: StripeCustomerOwner,
  ): Promise<string> {
    const customer = await this.createCustomer(
      user.id,
      user.email,
      user.name || undefined,
    );

    try {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { providerCustomerId: customer.id },
      });
      return customer.id;
    } catch (error) {
      await this.cleanupCustomer(customer.id);
      throw error;
    }
  }

  async cleanupCustomer(customerId: string): Promise<void> {
    try {
      await this.deleteCustomer(customerId);
    } catch (deleteError) {
      this.logger.warn(
        `Failed to clean up Stripe customer ${customerId}: ${deleteError}`,
      );
      await this.enqueueCustomerCleanup(customerId);
    }
  }

  async enqueueCustomerCleanup(customerId: string): Promise<void> {
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

  async createCustomer(
    userId: string,
    email: string,
    name?: string,
  ): Promise<PaymentCustomer> {
    return this.paymentAdapter.createCustomer(email, name, { userId: String(userId) });
  }

  async deleteCustomer(customerId: string): Promise<void> {
    return this.paymentAdapter.deleteCustomer(customerId);
  }

  async getCustomer(
    customerId: string,
  ): Promise<PaymentCustomer | null> {
    return this.paymentAdapter.getCustomer(customerId);
  }

  async customerExists(customerId: string): Promise<boolean> {
    return this.paymentAdapter.customerExists(customerId);
  }

  async getFreePriceId(): Promise<string | null> {
    const freePlan = await this.prisma.plan.findFirst({
      where: { isFree: true },
      include: { pricingOptions: true },
    });
    return freePlan?.pricingOptions[0]?.providerPriceId ?? null;
  }

  async ensureFreeSubscription(
    customerId: string,
  ): Promise<PaymentSubscription | null> {
    const freePriceId = await this.getFreePriceId();
    if (!freePriceId) return null;

    const existingSubs = await this.paymentAdapter.listSubscriptions(customerId);
    const hasActive = existingSubs.some(s =>
      s.status === SubscriptionStatus.ACTIVE || s.status === SubscriptionStatus.TRIALING || s.status === SubscriptionStatus.PAST_DUE
    );
    if (hasActive) return null;

    return this.paymentAdapter.createSubscription(customerId, freePriceId);
  }

  async findActiveSubscription(
    customerId: string,
  ): Promise<PaymentSubscription | null> {
    const subs = await this.paymentAdapter.listSubscriptions(customerId);
    const live = subs.filter(s => s.status === SubscriptionStatus.ACTIVE || s.status === SubscriptionStatus.TRIALING || s.status === SubscriptionStatus.PAST_DUE);
    if (live.length === 0) return null;
    if (live.length === 1) return live[0];

    const freePriceId = await this.getFreePriceId();
    const sorted = [...live].sort((a, b) => b.created - a.created);
    return sorted.find(s => freePriceId == null || s.items[0]?.priceId !== freePriceId) ?? sorted[0];
  }

  async getLatestPaidInvoice(
    subscriptionId: string,
  ): Promise<PaymentInvoice | null> {
    return this.paymentAdapter.getLatestPaidInvoice(subscriptionId);
  }

  async subscribeToFreePlan(
    customerId: string,
  ): Promise<PaymentSubscription | null> {
    const freePriceId = await this.getFreePriceId();
    if (!freePriceId) return null;
    return this.paymentAdapter.createSubscription(customerId, freePriceId);
  }

  async createOffSessionSubscription(
    userId: string,
    priceId: string,
    customerId: string,
    paymentMethodId: string,
  ): Promise<OffSessionSubscriptionResult> {
    return this.paymentAdapter.createOffSessionSubscription({
      customerId,
      priceId,
      paymentMethodId,
      metadata: { [STRIPE_METADATA_KEY.USER_ID]: String(userId) },
    });
  }

  async createAddonPayment(
    userId: string,
    addon: AddonPackage,
    customerId: string,
    paymentMethodId: string,
  ): Promise<OffSessionPaymentResult> {
    return this.paymentAdapter.createOffSessionPayment({
      customerId,
      paymentMethodId,
      amount: formatDatabaseAmountToStripe(Number(addon.price), addon.currency),
      currency: addon.currency,
      description: `Addon: ${addon.name}`,
      metadata: {
        [STRIPE_METADATA_KEY.USER_ID]: String(userId),
        [STRIPE_METADATA_KEY.ADDON_PACKAGE_ID]: addon.id,
      },
    });
  }

  async createSetupIntent(customerId: string): Promise<SetupIntentResult> {
    return this.paymentAdapter.createSetupIntent(customerId);
  }

  async getPaymentMethod(paymentMethodId: string): Promise<PaymentMethodDetails | null> {
    return this.paymentAdapter.getPaymentMethod(paymentMethodId);
  }

  async listPaymentMethods(customerId: string): Promise<PaymentMethodDetails[]> {
    return this.paymentAdapter.listPaymentMethods(customerId);
  }

  async detachPaymentMethod(paymentMethodId: string): Promise<void> {
    return this.paymentAdapter.detachPaymentMethod(paymentMethodId);
  }

  async setDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
    return this.paymentAdapter.setDefaultPaymentMethod(customerId, paymentMethodId);
  }

  async getDefaultPaymentMethodId(customerId: string): Promise<string | null> {
    return this.paymentAdapter.getDefaultPaymentMethodId(customerId);
  }

  mapRawPaymentMethod(rawPaymentMethod: unknown): PaymentMethodDetails {
    return this.paymentAdapter.mapRawPaymentMethod(rawPaymentMethod);
  }

  async createBillingPortalSession(
    customerId: string,
    returnUrl?: string,
  ): Promise<BillingPortalSession> {
    return this.paymentAdapter.createBillingPortalSession(
      customerId,
      returnUrl,
    );
  }

  constructWebhookEvent(rawBody: Buffer, signature: string): WebhookEvent {
    return this.paymentAdapter.constructWebhookEvent(rawBody, signature);
  }

  async cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void> {
    return this.paymentAdapter.cancelSubscriptionAtPeriodEnd(subscriptionId);
  }

  async cancelSubscriptionNow(subscriptionId: string): Promise<void> {
    return this.paymentAdapter.cancelSubscriptionNow(subscriptionId);
  }

  mapRawSubscription(rawSubscription: unknown): PaymentSubscription {
    return this.paymentAdapter.mapRawSubscription(rawSubscription);
  }

  mapRawInvoice(rawInvoice: unknown): PaymentInvoice {
    return this.paymentAdapter.mapRawInvoice(rawInvoice);
  }

  async upgradeSubscriptionTier(userId: string, newPricingOptionId: string): Promise<PaymentSubscription> {
    const currentSub = await this.prisma.subscription.findUnique({
      where: { userId },
    });

    if (!currentSub || !currentSub.providerSubscriptionId) {
      throw new BadRequestException("No active subscription found to upgrade");
    }

    const newPricingOption = await this.prisma.pricingOption.findUnique({
      where: { id: newPricingOptionId },
    });

    if (!newPricingOption || !newPricingOption.providerPriceId) {
      throw new BadRequestException("Invalid new pricing option");
    }

    const updatedStripeSub = await this.paymentAdapter.upgradeSubscriptionTier(
      currentSub.providerSubscriptionId,
      newPricingOption.providerPriceId
    );

    await this.prisma.subscription.update({
      where: { id: currentSub.id },
      data: {
        pricingOptionId: newPricingOption.id,
      }
    });

    return updatedStripeSub;
  }

  async upgradeSubscriptionCycle(userId: string, newPricingOptionId: string): Promise<PaymentSubscription> {
    const currentSub = await this.prisma.subscription.findUnique({
      where: { userId },
    });

    if (!currentSub || !currentSub.providerSubscriptionId) {
      throw new BadRequestException("No active subscription found to upgrade");
    }

    const newPricingOption = await this.prisma.pricingOption.findUnique({
      where: { id: newPricingOptionId },
    });

    if (!newPricingOption || !newPricingOption.providerPriceId) {
      throw new BadRequestException("Invalid new pricing option");
    }

    const updatedStripeSub = await this.paymentAdapter.upgradeSubscriptionCycle(
      currentSub.providerSubscriptionId,
      newPricingOption.providerPriceId
    );

    await this.prisma.subscription.update({
      where: { id: currentSub.id },
      data: {
        pricingOptionId: newPricingOption.id,
      }
    });

    return updatedStripeSub;
  }

  async previewUpgradeSubscriptionTier(userId: string, newPricingOptionId: string): Promise<any> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.providerCustomerId) {
      throw new BadRequestException("User does not have a Stripe customer account.");
    }

    const currentSub = await this.prisma.subscription.findUnique({
      where: { userId },
    });

    if (!currentSub || !currentSub.providerSubscriptionId) {
      throw new BadRequestException("No active subscription found to preview upgrade");
    }

    const newPricingOption = await this.prisma.pricingOption.findUnique({
      where: { id: newPricingOptionId },
    });

    if (!newPricingOption || !newPricingOption.providerPriceId) {
      throw new BadRequestException("Invalid new pricing option");
    }

    return await this.paymentAdapter.previewUpgradeSubscriptionTier(
      user.providerCustomerId,
      currentSub.providerSubscriptionId,
      newPricingOption.providerPriceId
    );
  }

  async previewUpgradeSubscriptionCycle(userId: string, newPricingOptionId: string): Promise<any> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.providerCustomerId) {
      throw new BadRequestException("User does not have a Stripe customer account.");
    }

    const currentSub = await this.prisma.subscription.findUnique({
      where: { userId },
    });

    if (!currentSub || !currentSub.providerSubscriptionId) {
      throw new BadRequestException("No active subscription found to preview upgrade");
    }

    const newPricingOption = await this.prisma.pricingOption.findUnique({
      where: { id: newPricingOptionId },
    });

    if (!newPricingOption || !newPricingOption.providerPriceId) {
      throw new BadRequestException("Invalid new pricing option");
    }

    return await this.paymentAdapter.previewUpgradeSubscriptionCycle(
      user.providerCustomerId,
      currentSub.providerSubscriptionId,
      newPricingOption.providerPriceId
    );
  }
}
