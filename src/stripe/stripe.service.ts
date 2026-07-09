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

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);

  constructor(
    @Inject("PAYMENT_ADAPTER")
    private readonly paymentAdapter: IPaymentAdapter,
  ) { }

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
