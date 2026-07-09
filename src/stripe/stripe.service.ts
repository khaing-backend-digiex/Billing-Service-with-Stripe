import { Injectable, Inject, Logger } from "@nestjs/common";
import {
  IPaymentAdapter,
  StripeSubscription,
  StripeInvoice,
  StripeCheckoutSession,
  StripeCustomer,
  StripeDeletedCustomer,
  StripePaymentIntent,
  StripeBillingPortalSession,
  StripeEvent,
} from "./adapter/payment-adapter.interface";
import { PrismaService } from "../database/prisma.service";

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
  ) { }

  // ── Customer management ──────────────────────────────────────────

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

  // ── Adapter pass-through ─────────────────────────────────────────

  async createCustomer(
    userId: number,
    email: string,
    name?: string,
  ): Promise<StripeCustomer> {
    return this.paymentAdapter.createCustomer(userId, email, name);
  }

  async deleteCustomer(customerId: string): Promise<void> {
    return this.paymentAdapter.deleteCustomer(customerId);
  }

  async getCustomer(
    customerId: string,
  ): Promise<StripeCustomer | StripeDeletedCustomer> {
    return this.paymentAdapter.getCustomer(customerId);
  }

  async customerExists(customerId: string): Promise<boolean> {
    return this.paymentAdapter.customerExists(customerId);
  }

  async getFreePriceId(): Promise<string | null> {
    return this.paymentAdapter.getFreePriceId();
  }

  async ensureFreeSubscription(
    customerId: string,
  ): Promise<StripeSubscription | null> {
    return this.paymentAdapter.ensureFreeSubscription(customerId);
  }

  async findActiveSubscription(
    customerId: string,
  ): Promise<StripeSubscription | null> {
    return this.paymentAdapter.findActiveSubscription(customerId);
  }

  async getLatestPaidInvoice(
    subscriptionId: string,
  ): Promise<StripeInvoice | null> {
    return this.paymentAdapter.getLatestPaidInvoice(subscriptionId);
  }

  async subscribeToFreePlan(
    customerId: string,
  ): Promise<StripeSubscription | null> {
    return this.paymentAdapter.subscribeToFreePlan(customerId);
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
  ): Promise<StripeCheckoutSession> {
    return this.paymentAdapter.createCheckoutSession(
      userId,
      priceId,
      mode,
      customerId,
      extraMetadata,
      successUrl,
      cancelUrl,
    );
  }

  async createPaymentIntent(
    userId: number,
    amount: number,
    currency: string = "usd",
    description?: string,
    customerId?: string,
  ): Promise<StripePaymentIntent> {
    return this.paymentAdapter.createPaymentIntent(
      userId,
      amount,
      currency,
      description,
      customerId,
    );
  }

  async createBillingPortalSession(
    customerId: string,
    returnUrl?: string,
  ): Promise<StripeBillingPortalSession> {
    return this.paymentAdapter.createBillingPortalSession(
      customerId,
      returnUrl,
    );
  }

  constructWebhookEvent(rawBody: Buffer, signature: string): StripeEvent {
    return this.paymentAdapter.constructWebhookEvent(rawBody, signature);
  }

  async cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void> {
    return this.paymentAdapter.cancelSubscriptionAtPeriodEnd(subscriptionId);
  }

  async cancelSubscriptionNow(subscriptionId: string): Promise<void> {
    return this.paymentAdapter.cancelSubscriptionNow(subscriptionId);
  }
}

