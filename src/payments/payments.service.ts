import { Injectable, BadRequestException } from "@nestjs/common";
import { PaymentProvider } from "@prisma/client";
import { IPaymentStrategy } from "./interfaces/payment-strategy.interface";
import { StripeStrategy } from "./strategies/stripe.strategy";

@Injectable()
export class PaymentsService {
  constructor(
    private readonly stripeStrategy: StripeStrategy,
  ) {}

  getStrategy(provider: PaymentProvider = PaymentProvider.STRIPE): IPaymentStrategy {
    switch (provider) {
      case PaymentProvider.STRIPE:
        return this.stripeStrategy;
      default:
        throw new BadRequestException(`Payment provider ${provider} is not supported.`);
    }
  }

  async createCustomer(userId: number, email: string, name?: string, provider?: PaymentProvider) {
    return this.getStrategy(provider).createCustomer(userId, email, name);
  }

  async createCheckoutSession(
    userId: number,
    priceId: string,
    mode: "payment" | "subscription" = "payment",
    customerId?: string,
    provider?: PaymentProvider
  ) {
    return this.getStrategy(provider).createCheckoutSession(userId, priceId, mode, customerId);
  }

  async createPaymentIntent(
    userId: number,
    amount: number,
    currency: string = "usd",
    description?: string,
    customerId?: string,
    provider?: PaymentProvider
  ) {
    return this.getStrategy(provider).createPaymentIntent(userId, amount, currency, description, customerId);
  }

  async createBillingPortalSession(customerId: string, returnUrl?: string, provider?: PaymentProvider) {
    return this.getStrategy(provider).createBillingPortalSession(customerId, returnUrl);
  }

  async cancelSubscriptionAtPeriodEnd(subscriptionId: string, provider?: PaymentProvider) {
    return this.getStrategy(provider).cancelSubscriptionAtPeriodEnd(subscriptionId);
  }
}
