import { Injectable, Logger, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PaymentStatus, PaymentProvider } from "@prisma/client";
import Stripe from "stripe";
import { IPaymentStrategy } from "../interfaces/payment-strategy.interface";
import { UsersService } from "../../users/users.service";
import { PrismaService } from "../../database/prisma.service";

@Injectable()
export class StripeStrategy implements IPaymentStrategy {
  private readonly stripe: Stripe;
  private readonly logger = new Logger(StripeStrategy.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
  ) {
    const secretKey = this.configService.get<string>("STRIPE_SECRET_KEY");
    if (!secretKey) {
      this.logger.warn(" STRIPE_SECRET_KEY is not set. Stripe features will not work.");
    }
    this.stripe = new Stripe(secretKey || "");
  }

  async createCustomer(userId: number, email: string, name?: string): Promise<{ customerId: string }> {
    try {
      const customer = await this.stripe.customers.create({
        email,
        name,
        metadata: { userId: String(userId) },
      });

      await this.usersService.updateStripeCustomerId(userId, customer.id);
      this.logger.log(`✅ Created Stripe customer ${customer.id} for user ${userId}`);
      
      return { customerId: customer.id };
    } catch (error) {
      this.logger.error(`Failed to create Stripe customer: ${error}`);
      throw new InternalServerErrorException("Failed to create Stripe customer");
    }
  }

  async createCheckoutSession(
    userId: number,
    priceId: string,
    mode: "payment" | "subscription" = "payment",
    customerId?: string,
  ): Promise<{ sessionId: string; url: string }> {
    try {
      const sessionData: Stripe.Checkout.SessionCreateParams = {
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        mode,
        success_url: this.configService.get<string>("STRIPE_SUCCESS_URL", "http://localhost:3000/success") + "?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: this.configService.get<string>("STRIPE_CANCEL_URL", "http://localhost:3000/cancel"),
        metadata: { userId: String(userId) },
      };

      if (customerId) {
        sessionData.customer = customerId;
      }

      const session = await this.stripe.checkout.sessions.create(sessionData);
      this.logger.log(`Created checkout session ${session.id} for user ${userId}`);
      
      return { sessionId: session.id, url: session.url || "" };
    } catch (error) {
      this.logger.error(`Failed to create checkout session: ${error}`);
      throw new InternalServerErrorException("Failed to create checkout session");
    }
  }

  async createPaymentIntent(
    userId: number,
    amount: number,
    currency: string = "usd",
    description?: string,
    customerId?: string,
  ): Promise<{ paymentIntentId: string; clientSecret: string | null; amount: number; currency: string }> {
    try {
      const intentData: Stripe.PaymentIntentCreateParams = {
        amount,
        currency,
        description,
        metadata: { userId: String(userId) },
        automatic_payment_methods: { enabled: true },
      };

      if (customerId) {
        intentData.customer = customerId;
      }

      const paymentIntent = await this.stripe.paymentIntents.create(intentData);

      await this.prisma.payment.create({
        data: {
          providerPaymentId: paymentIntent.id,
          amount,
          currency,
          provider: PaymentProvider.STRIPE,
          status: PaymentStatus.PENDING,
          userId
        },
      });

      this.logger.log(` Created payment intent ${paymentIntent.id} for user ${userId}`);
      
      return {
        paymentIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
      };
    } catch (error) {
      this.logger.error(`Failed to create payment intent: ${error}`);
      throw new InternalServerErrorException("Failed to create payment intent");
    }
  }

  async createBillingPortalSession(customerId: string, returnUrl?: string): Promise<{ url: string }> {
    try {
      const session = await this.stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl || this.configService.get<string>("STRIPE_SUCCESS_URL", "http://localhost:3000"),
      });

      this.logger.log(` Created billing portal session for customer ${customerId}`);
      return { url: session.url };
    } catch (error) {
      this.logger.error(`Failed to create billing portal session: ${error}`);
      throw new InternalServerErrorException("Failed to create billing portal session");
    }
  }

  async cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
  }
}
