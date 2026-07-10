import {
  Injectable,
  Logger,
  BadRequestException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IPaymentAdapter } from "../../payments/types/payment-adapter.interface";
import {
  PaymentCustomer,
  PaymentSubscription,
  PaymentInvoice,
  CheckoutSession,
  PaymentIntentResult,
  BillingPortalSession,
  WebhookEvent,
  CreateCheckoutParams,
  CreatePaymentIntentParams,
  RecurringInterval,
} from "../../payments/types/payment.types";
import Stripe from "stripe";
import { SubscriptionStatus } from "@prisma/client";

const STRIPE_STATUS_MAP: Record<string, SubscriptionStatus> = {
  active: SubscriptionStatus.ACTIVE,
  past_due: SubscriptionStatus.PAST_DUE,
  canceled: SubscriptionStatus.CANCELLED,
  unpaid: SubscriptionStatus.PAST_DUE,
  trialing: SubscriptionStatus.TRIALING,
  paused: SubscriptionStatus.PAUSED,
  incomplete: SubscriptionStatus.PAST_DUE,
  incomplete_expired: SubscriptionStatus.EXPIRED,
};

@Injectable()
export class StripeAdapter implements IPaymentAdapter {
  private readonly stripe: Stripe;
  private readonly logger = new Logger(StripeAdapter.name);

  constructor(private readonly configService: ConfigService) {
    const secretKey = this.configService.get<string>("STRIPE_SECRET_KEY");
    if (!secretKey) {
      throw new Error("STRIPE_SECRET_KEY is required");
    }
    this.stripe = new Stripe(secretKey);
  }

  async createCustomer(email: string, name?: string, metadata?: Record<string, string>): Promise<PaymentCustomer> {
    const customer = await this.stripe.customers.create({ email, name, metadata });
    return this.mapCustomer(customer);
  }

  async deleteCustomer(customerId: string): Promise<void> {
    try {
      await this.stripe.customers.del(customerId);
      this.logger.log(`Deleted Stripe customer ${customerId}`);
    } catch (error) {
      if ((error as Stripe.StripeRawError)?.code === "resource_missing") {
        return;
      }
      throw error;
    }
  }

  async getCustomer(customerId: string): Promise<PaymentCustomer | null> {
    try {
      const customer = await this.stripe.customers.retrieve(customerId);
      if ((customer as Stripe.DeletedCustomer).deleted) return null;
      return this.mapCustomer(customer as Stripe.Customer);
    } catch (error) {
      if ((error as Stripe.StripeRawError)?.code === "resource_missing") return null;
      throw error;
    }
  }

  async customerExists(customerId: string): Promise<boolean> {
    const customer = await this.getCustomer(customerId);
    return customer !== null && !customer.deleted;
  }

  async createSubscription(customerId: string, priceId: string): Promise<PaymentSubscription> {
    const sub = await this.stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
    });
    this.logger.log(`Created subscription ${sub.id} for customer ${customerId} (price: ${priceId})`);
    return this.mapSubscription(sub);
  }

  async cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
  }

  async cancelSubscriptionNow(subscriptionId: string): Promise<void> {
    try {
      const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
      if (subscription.status === "canceled") {
        this.logger.log(`Subscription ${subscriptionId} already canceled on Stripe`);
        return;
      }
      await this.stripe.subscriptions.cancel(subscriptionId);
      this.logger.log(`Cancelled Stripe subscription ${subscriptionId} immediately`);
    } catch (error: any) {
      if (error?.code === "resource_missing") {
        this.logger.log(`Subscription ${subscriptionId} not found on Stripe – nothing to cancel`);
        return;
      }
      throw error;
    }
  }

  async listSubscriptions(customerId: string): Promise<PaymentSubscription[]> {
    const subs = await this.stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
    });
    return subs.data.map(s => this.mapSubscription(s));
  }

  async getLatestPaidInvoice(subscriptionId: string): Promise<PaymentInvoice | null> {
    const invoices = await this.stripe.invoices.list({
      subscription: subscriptionId,
      status: "paid",
      limit: 1,
    });
    if (!invoices.data[0]) return null;
    return this.mapInvoice(invoices.data[0]);
  }

  async createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutSession> {
    try {
      const sessionData: Stripe.Checkout.SessionCreateParams = {
        payment_method_types: ["card"],
        line_items: [{ price: params.priceId, quantity: 1 }],
        mode: params.mode,
        success_url: params.successUrl || this.configService.get<string>("STRIPE_SUCCESS_URL", "http://localhost:3000/stripe/success?session_id={CHECKOUT_SESSION_ID}"),
        cancel_url: params.cancelUrl || this.configService.get<string>("STRIPE_CANCEL_URL", "http://localhost:3000/stripe/cancel?session_id={CHECKOUT_SESSION_ID}"),
        metadata: params.metadata,
      };

      if (params.mode === "payment") {
        sessionData.payment_intent_data = { metadata: params.metadata };
      } else if (params.mode === "subscription") {
        sessionData.subscription_data = { metadata: params.subscriptionMetadata };
      }

      if (params.customerId) {
        sessionData.customer = params.customerId;
      }

      const session = await this.stripe.checkout.sessions.create(sessionData);
      return { id: session.id, url: session.url };
    } catch (error) {
      this.logger.error(`Failed to create checkout session: ${error}`);
      throw new BadRequestException("Failed to create checkout session");
    }
  }

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentResult> {
    try {
      const intentData: Stripe.PaymentIntentCreateParams = {
        amount: params.amount,
        currency: params.currency,
        description: params.description,
        metadata: params.metadata,
        automatic_payment_methods: { enabled: true },
      };

      if (params.customerId) {
        intentData.customer = params.customerId;
      }

      const paymentIntent = await this.stripe.paymentIntents.create(intentData);
      return {
        id: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        status: paymentIntent.status,
        metadata: paymentIntent.metadata,
      };
    } catch (error) {
      this.logger.error(`Failed to create payment intent: ${error}`);
      throw new BadRequestException("Failed to create payment intent");
    }
  }

  async createBillingPortalSession(customerId: string, returnUrl?: string): Promise<BillingPortalSession> {
    try {
      const session = await this.stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl || this.configService.get<string>("STRIPE_SUCCESS_URL", "http://localhost:3000"),
      });
      return { url: session.url };
    } catch (error) {
      this.logger.error(`Failed to create billing portal session: ${error}`);
      throw new BadRequestException("Failed to create billing portal session");
    }
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

  constructWebhookEvent(rawBody: Buffer, signature: string): WebhookEvent {
    const webhookSecret = this.configService.get<string>("STRIPE_WEBHOOK_SECRET");
    if (!webhookSecret) {
      throw new BadRequestException("STRIPE_WEBHOOK_SECRET is not configured");
    }

    const event = this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    return {
      id: event.id,
      type: event.type,
      data: event,
      created: event.created,
    };
  }

  async createProduct(name: string): Promise<string> {
    const product = await this.stripe.products.create({ name });
    return product.id;
  }

  async createRecurringPrice(productId: string, amount: number, currency: string, recurring: RecurringInterval): Promise<string> {
    const price = await this.stripe.prices.create({
      product: productId,
      unit_amount: amount,
      currency,
      recurring: {
        interval: recurring.interval as Stripe.PriceCreateParams.Recurring.Interval,
        interval_count: recurring.intervalCount,
      },
    });
    return price.id;
  }

  async createOneTimePrice(productId: string, amount: number, currency: string): Promise<string> {
    const price = await this.stripe.prices.create({
      product: productId,
      unit_amount: amount,
      currency,
    });
    return price.id;
  }

  private mapCustomer(customer: Stripe.Customer | Stripe.DeletedCustomer): PaymentCustomer {
    return {
      id: customer.id,
      email: (customer as Stripe.Customer).email ?? '',
      name: (customer as Stripe.Customer).name ?? null,
      deleted: (customer as Stripe.DeletedCustomer).deleted ?? false,
      metadata: (customer as Stripe.Customer).metadata ?? {},
    };
  }

  mapRawSubscription(rawSubscription: unknown): PaymentSubscription {
    return this.mapSubscription(rawSubscription as Stripe.Subscription);
  }

  mapRawInvoice(rawInvoice: unknown): PaymentInvoice {
    return this.mapInvoice(rawInvoice as Stripe.Invoice);
  }

  private mapSubscription(stripeSubscription: Stripe.Subscription): PaymentSubscription {
    const status = STRIPE_STATUS_MAP[stripeSubscription.status] || SubscriptionStatus.PAST_DUE;
    return {
      id: stripeSubscription.id,
      customerId: typeof stripeSubscription.customer === 'string' ? stripeSubscription.customer : stripeSubscription.customer.id,
      status: status,
      items: stripeSubscription.items.data.map(item => ({
        priceId: typeof item.price === 'string' ? item.price : item.price.id,
        currentPeriodStart: (item as any).current_period_start,
        currentPeriodEnd: (item as any).current_period_end,
      })),
      currentPeriodStart: (stripeSubscription.items.data[0] as any)?.current_period_start ?? stripeSubscription.created,
      currentPeriodEnd: (stripeSubscription.items.data[0] as any)?.current_period_end ?? stripeSubscription.created,
      cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
      cancelAt: stripeSubscription.cancel_at,
      trialStart: stripeSubscription.trial_start,
      trialEnd: stripeSubscription.trial_end,
      cancellationReason: stripeSubscription.cancellation_details?.reason ?? null,
      created: stripeSubscription.created,
    };
  }

  private mapInvoice(i: Stripe.Invoice): PaymentInvoice {
    return {
      id: i.id,
      customerId: typeof i.customer === 'string' ? i.customer : (i.customer as any)?.id,
      subscriptionId:
        (typeof i.subscription === 'string' ? i.subscription : (i.subscription as any)?.id) ??
        (i as any).parent?.subscription_details?.subscription ??
        null,
      amountDue: i.amount_due,
      amountPaid: i.amount_paid,
      currency: i.currency,
      status: i.status as string,
      billingReason: i.billing_reason,
      periodStart: i.lines.data[0]?.period?.start ,
      periodEnd: i.lines.data[0]?.period?.end,
      dueDate: i.due_date,
      attemptCount: i.attempt_count,
      nextPaymentAttempt: i.next_payment_attempt,
      paymentIntentId: typeof i.payment_intent === 'string' ? i.payment_intent : (i.payment_intent as any)?.id,
      lines: i.lines.data.map(l => ({
        type: l.type as string,
        priceId:
          (l as any).pricing?.price_details?.price ??
          (typeof l.price === 'string' ? l.price : l.price?.id) ??
          null,
        subscriptionId:
          (typeof l.subscription === 'string' ? l.subscription : (l.subscription as any)?.id) ??
          (l as any).parent?.subscription_item_details?.subscription ??
          null,
      })),
    };
  }
}