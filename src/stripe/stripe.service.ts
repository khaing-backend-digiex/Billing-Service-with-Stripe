import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import Stripe from "stripe";
import { Payment, PaymentStatus } from "../database/entities/payment.entity";
import { UsersService } from "../users/users.service";

@Injectable()
export class StripeService {
  private readonly stripe: Stripe;
  private readonly logger = new Logger(StripeService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
  ) {
    const secretKey = this.configService.get<string>("STRIPE_SECRET_KEY");
    if (!secretKey) {
      this.logger.warn(
        "⚠️  STRIPE_SECRET_KEY is not set. Stripe features will not work.",
      );
    }
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

      this.logger.log(
        `✅ Created Stripe customer ${customer.id} for user ${userId}`,
      );
      return customer;
    } catch (error) {
      this.logger.error(` Failed to create Stripe customer: ${error}`);
      throw new InternalServerErrorException(
        "Failed to create Stripe customer",
      );
    }
  }

  async getCustomer(
    customerId: string,
  ): Promise<Stripe.Customer | Stripe.DeletedCustomer> {
    return this.stripe.customers.retrieve(customerId);
  }

  async createCheckoutSession(
    userId: number,
    priceId: string,
    mode: "payment" | "subscription" = "payment",
    customerId?: string,
  ): Promise<Stripe.Checkout.Session> {
    try {
      const sessionData: Stripe.Checkout.SessionCreateParams = {
        payment_method_types: ["card"],
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        mode,
        success_url:
          this.configService.get<string>(
            "STRIPE_SUCCESS_URL",
            "http://localhost:3000/success",
          ) + "?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: this.configService.get<string>(
          "STRIPE_CANCEL_URL",
          "http://localhost:3000/cancel",
        ),
        metadata: { userId: String(userId) },
      };

      if (customerId) {
        sessionData.customer = customerId;
      }

      const session = await this.stripe.checkout.sessions.create(sessionData);

      this.logger.log(
        ` Created checkout session ${session.id} for user ${userId}`,
      );
      return session;
    } catch (error) {
      this.logger.error(`Failed to create checkout session: ${error}`);
      throw new InternalServerErrorException(
        "Failed to create checkout session",
      );
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

      const payment = this.paymentRepository.create({
        stripePaymentIntentId: paymentIntent.id,
        amount,
        currency,
        description,
        status: PaymentStatus.PENDING,
        userId,
      });
      await this.paymentRepository.save(payment);

      this.logger.log(
        `✅ Created payment intent ${paymentIntent.id} for user ${userId}`,
      );
      return paymentIntent;
    } catch (error) {
      this.logger.error(`  Failed to create payment intent: ${error}`);
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
          this.configService.get<string>(
            "STRIPE_SUCCESS_URL",
            "http://localhost:3000",
          ),
      });

      this.logger.log(
        `✅ Created billing portal session for customer ${customerId}`,
      );
      return session;
    } catch (error) {
      this.logger.error(` Failed to create billing portal session: ${error}`);
      throw new InternalServerErrorException(
        "Failed to create billing portal session",
      );
    }
  }

  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    const webhookSecret = this.configService.get<string>(
      "STRIPE_WEBHOOK_SECRET",
    );
    if (!webhookSecret) {
      throw new InternalServerErrorException(
        "STRIPE_WEBHOOK_SECRET is not configured",
      );
    }

    return this.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      webhookSecret,
    );
  }

  async getPaymentsByUserId(userId: number): Promise<Payment[]> {
    return this.paymentRepository.find({
      where: { userId },
      order: { createdAt: "DESC" },
    });
  }

  async updatePaymentStatus(
    stripePaymentIntentId: string,
    status: PaymentStatus,
  ): Promise<void> {
    await this.paymentRepository.update({ stripePaymentIntentId }, { status });
  }

  async saveCheckoutPayment(
    sessionId: string,
    userId: number,
    amount: number,
    currency: string,
    status: PaymentStatus,
  ): Promise<Payment> {
    const payment = this.paymentRepository.create({
      stripeCheckoutSessionId: sessionId,
      amount,
      currency,
      status,
      userId,
    });
    return this.paymentRepository.save(payment);
  }
}
