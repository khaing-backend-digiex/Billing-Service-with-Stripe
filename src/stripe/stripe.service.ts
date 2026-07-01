import {
  Injectable,
  Logger,
  InternalServerErrorException,
  forwardRef,
  Inject,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Stripe from "stripe";
import { PrismaService } from "../database/prisma.service";
import { UsersService } from "../users/users.service";
import { PaymentStatus, PaymentProvider, SubscriptionStatus } from "@prisma/client";
import { PLAN_CODES } from "../common/constants/plan.constants";

@Injectable()
export class StripeService {
  private readonly stripe: Stripe;
  private readonly logger = new Logger(StripeService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => UsersService))
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
  ) {
    const secretKey = this.configService.get<string>("STRIPE_SECRET_KEY");
    this.stripe = new Stripe(secretKey || "");
  }

  async createCustomer(
    userId: number,
    email: string,
    name?: string,
  ): Promise<Stripe.Customer> {
    try {
      const customer = await this.stripe.customers.create({
        email,
        name,
        metadata: { userId: String(userId) },
      });

      await this.usersService.updateStripeCustomerId(userId, customer.id);

      this.logger.log(`✅ Created Stripe customer ${customer.id} for user ${userId}`);
      return customer;
    } catch (error) {
      this.logger.error(`Failed to create Stripe customer: ${error}`);
      throw new InternalServerErrorException("Failed to create Stripe customer");
    }
  }

  async getCustomer(customerId: string): Promise<Stripe.Customer | Stripe.DeletedCustomer> {
    return this.stripe.customers.retrieve(customerId);
  }

  async subscribeToFreePlan(userId: number, customerId: string): Promise<Stripe.Subscription> {
    const freePlan = await this.prisma.plan.findUnique({
      where: { code: PLAN_CODES.FREE },
      include: { pricingOptions: { include: { billingCycle: true } } },
    });

    if (!freePlan || freePlan.pricingOptions.length === 0) {
      this.logger.warn("Free plan not found in database. Skipping free subscription.");
      return null as any;
    }

    const pricingOption = freePlan.pricingOptions[0];
    
    let stripeSubscription;
    if (pricingOption.providerPriceId) {
      try {
        stripeSubscription = await this.stripe.subscriptions.create({
          customer: customerId,
          items: [{ price: pricingOption.providerPriceId }],
        });
        this.logger.log(`✅ Subscribed customer ${customerId} to free plan (price: ${pricingOption.providerPriceId})`);
      } catch (error) {
        this.logger.error(`Failed to subscribe customer to free plan on Stripe: ${error}`);
      }
    }

    return stripeSubscription as Stripe.Subscription;
  }

  async hasDefaultPaymentMethod(customerId: string): Promise<boolean> {
    try {
      const customer = await this.stripe.customers.retrieve(customerId) as Stripe.Customer;
      if (customer.deleted) return false;
      if (customer.invoice_settings?.default_payment_method) return true;
      if (customer.default_source) return true;
      
      const paymentMethods = await this.stripe.paymentMethods.list({
        customer: customerId,
        type: 'card',
      });
      return paymentMethods.data.length > 0;
    } catch (error) {
      this.logger.error(`Error checking payment methods for customer ${customerId}`, error);
      return false;
    }
  }

  async subscribeToPaidPlan(userId: number, customerId: string, priceId: string): Promise<Stripe.Subscription> {
    try {
      const subscription = await this.stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId }],
        expand: ['latest_invoice.payment_intent'],
      });
      this.logger.log(`✅ Subscribed customer ${customerId} to paid plan (price: ${priceId})`);
      return subscription;
    } catch (error) {
      this.logger.error(`Failed to subscribe customer to paid plan: ${error}`);
      throw new InternalServerErrorException("Failed to create paid subscription on Stripe");
    }
  }

  async createCheckoutSession(
    userId: number,
    priceId: string,
    mode: "payment" | "subscription" = "payment",
    customerId?: string,
    extraMetadata?: Record<string, string>,
  ): Promise<Stripe.Checkout.Session> {
    try {
      const sessionData: Stripe.Checkout.SessionCreateParams = {
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        mode,
        success_url:
          this.configService.get<string>("STRIPE_SUCCESS_URL", "http://localhost:3000/success") +
          "?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: this.configService.get<string>("STRIPE_CANCEL_URL", "http://localhost:3000/cancel"),
        metadata: { userId: String(userId), ...extraMetadata },
      };

      if (customerId) {
        sessionData.customer = customerId;
      }

      const session = await this.stripe.checkout.sessions.create(sessionData);

      this.logger.log(`Created checkout session ${session.id} for user ${userId}`);
      return session;
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
  ): Promise<Stripe.PaymentIntent> {
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
          status: PaymentStatus.PENDING,
          userId,
          provider: PaymentProvider.STRIPE,
        },
      });

      this.logger.log(`✅ Created payment intent ${paymentIntent.id} for user ${userId}`);
      return paymentIntent;
    } catch (error) {
      this.logger.error(`Failed to create payment intent: ${error}`);
      throw new InternalServerErrorException("Failed to create payment intent");
    }
  }

  async createBillingPortalSession(
    customerId: string,
    returnUrl?: string,
  ): Promise<Stripe.BillingPortal.Session> {
    try {
      const session = await this.stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url:
          returnUrl ||
          this.configService.get<string>("STRIPE_SUCCESS_URL", "http://localhost:3000"),
      });

      this.logger.log(`✅ Created billing portal session for customer ${customerId}`);
      return session;
    } catch (error) {
      this.logger.error(`Failed to create billing portal session: ${error}`);
      throw new InternalServerErrorException("Failed to create billing portal session");
    }
  }

  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    const webhookSecret = this.configService.get<string>("STRIPE_WEBHOOK_SECRET");
    if (!webhookSecret) {
      throw new InternalServerErrorException("STRIPE_WEBHOOK_SECRET is not configured");
    }

    return this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  }

  async updatePaymentStatus(
    stripePaymentIntentId: string,
    status: PaymentStatus,
  ): Promise<void> {
    await this.prisma.payment.update({
      where: { providerPaymentId: stripePaymentIntentId },
      data: { status },
    });
  }

  async retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.retrieve(subscriptionId);
  }

  async cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
  }
}
