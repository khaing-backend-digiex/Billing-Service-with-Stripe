import { Injectable, BadRequestException } from "@nestjs/common";
import { PaymentProvider } from "@prisma/client";
import { StripeService } from "../stripe/stripe.service";

@Injectable()
export class PaymentsService {
  constructor(private readonly stripeService: StripeService) {}

  async createCustomer(userId: number, email: string, name?: string, provider?: PaymentProvider) {
    if (provider && provider !== PaymentProvider.STRIPE) {
      throw new BadRequestException(`Payment provider ${provider} is not supported.`);
    }
    const customer = await this.stripeService.createCustomer(userId, email, name);
    return { customerId: customer.id };
  }

  async createCheckoutSession(
    userId: number,
    priceId: string,
    mode: "payment" | "subscription" = "payment",
    customerId?: string,
    provider?: PaymentProvider,
    extraMetadata?: Record<string, string>,
  ) {
    if (provider && provider !== PaymentProvider.STRIPE) {
      throw new BadRequestException(`Payment provider ${provider} is not supported.`);
    }
    const session = await this.stripeService.createCheckoutSession(
      userId,
      priceId,
      mode,
      customerId,
      extraMetadata,
    );
    return { sessionId: session.id, url: session.url };
  }

  async createPaymentIntent(
    userId: number,
    amount: number,
    currency: string = "usd",
    description?: string,
    customerId?: string,
    provider?: PaymentProvider
  ) {
    if (provider && provider !== PaymentProvider.STRIPE) {
      throw new BadRequestException(`Payment provider ${provider} is not supported.`);
    }
    const paymentIntent = await this.stripeService.createPaymentIntent(userId, amount, currency, description, customerId);
    return {
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
    };
  }

  async createBillingPortalSession(customerId: string, returnUrl?: string, provider?: PaymentProvider) {
    if (provider && provider !== PaymentProvider.STRIPE) {
      throw new BadRequestException(`Payment provider ${provider} is not supported.`);
    }
    const session = await this.stripeService.createBillingPortalSession(customerId, returnUrl);
    return { url: session.url };
  }

  async cancelSubscriptionAtPeriodEnd(subscriptionId: string, provider?: PaymentProvider) {
    if (provider && provider !== PaymentProvider.STRIPE) {
      throw new BadRequestException(`Payment provider ${provider} is not supported.`);
    }
    await this.stripeService.cancelSubscriptionAtPeriodEnd(subscriptionId);
  }
}

