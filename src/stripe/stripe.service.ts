import { Injectable, Inject, Logger } from "@nestjs/common";
import { IPaymentAdapter } from "../payments/types/payment-adapter.interface";
import {
  PaymentCustomer,
  PaymentSubscription,
  PaymentInvoice,
  CheckoutSession,
  PaymentIntentResult,
  BillingPortalSession,
  WebhookEvent,
} from "../payments/types/payment.types";
import { PrismaService } from "../database/prisma.service";
import { PaymentStatus, PaymentProvider, SubscriptionStatus } from "@prisma/client";
import { PLAN_CODES } from "../common/constants/plan.constants";

type StripeCustomerOwner = {
  id: number;
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
    userId: number,
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
    const freePlan = await this.prisma.plan.findUnique({
      where: { code: PLAN_CODES.FREE },
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

  async hasDefaultPaymentMethod(customerId: string): Promise<boolean> {
    return this.paymentAdapter.hasDefaultPaymentMethod(customerId);
  }

  async createCheckoutSession(
    userId: number,
    priceId: string,
    mode: "payment" | "subscription" = "payment",
    customerId?: string,
    extraMetadata?: Record<string, string>,
    successUrl?: string,
    cancelUrl?: string,
  ): Promise<CheckoutSession> {
    return this.paymentAdapter.createCheckoutSession({
      customerId,
      priceId,
      mode,
      metadata: { userId: String(userId), ...extraMetadata },
      successUrl,
      cancelUrl,
    });
  }

  async createPaymentIntent(
    userId: number,
    amount: number,
    currency: string = "usd",
    description?: string,
    customerId?: string,
  ): Promise<PaymentIntentResult> {
    const intent = await this.paymentAdapter.createPaymentIntent({
      amount,
      currency,
      description,
      customerId,
      metadata: { userId: String(userId) },
    });

    await this.prisma.payment.create({
      data: {
        providerPaymentId: intent.id,
        amount,
        currency,
        status: PaymentStatus.PENDING,
        userId,
        provider: PaymentProvider.STRIPE,
      },
    });

    return intent;
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
}