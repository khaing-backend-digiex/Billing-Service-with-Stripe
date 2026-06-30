import { PaymentStatus } from "../../database/entities/payment.entity";

export interface IPaymentStrategy {
  createCustomer(userId: number, email: string, name?: string): Promise<{ customerId: string }>;
  
  createCheckoutSession(
    userId: number,
    priceId: string,
    mode: "payment" | "subscription",
    customerId?: string
  ): Promise<{ sessionId: string; url: string }>;

  createPaymentIntent(
    userId: number,
    amount: number,
    currency: string,
    description?: string,
    customerId?: string
  ): Promise<{ paymentIntentId: string; clientSecret: string | null; amount: number; currency: string }>;

  createBillingPortalSession(customerId: string, returnUrl?: string): Promise<{ url: string }>;

  cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void>;
}
