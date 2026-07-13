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
  PaymentMethodDetails,
  SetupIntentResult,
  OffSessionPaymentResult,
  OffSessionSubscriptionResult,
  BillingPortalSession,
  WebhookEvent,
  CreateOffSessionSubscriptionParams,
  CreateOffSessionPaymentParams,
  RecurringInterval,
} from "../../payments/types/payment.types";
import Stripe from "stripe";
import { SubscriptionStatus } from "@prisma/client";
import {
  OFF_SESSION_STATUS,
  OffSessionStatus,
} from "../../common/constants/payment.constants";
import {
  STRIPE_ERROR_CODE,
  STRIPE_SUBSCRIPTION_STATUS,
  STRIPE_PAYMENT_INTENT_STATUS,
  STRIPE_PAYMENT_METHOD_TYPE,
  STRIPE_SETUP_INTENT_USAGE,
  STRIPE_PAYMENT_BEHAVIOR,
  STRIPE_ALLOW_REDIRECTS,
  STRIPE_EXPAND,
} from "../../common/constants/stripe.constants";

const STRIPE_STATUS_MAP: Record<string, SubscriptionStatus> = {
  [STRIPE_SUBSCRIPTION_STATUS.ACTIVE]: SubscriptionStatus.ACTIVE,
  [STRIPE_SUBSCRIPTION_STATUS.PAST_DUE]: SubscriptionStatus.PAST_DUE,
  [STRIPE_SUBSCRIPTION_STATUS.CANCELED]: SubscriptionStatus.CANCELLED,
  [STRIPE_SUBSCRIPTION_STATUS.UNPAID]: SubscriptionStatus.PAST_DUE,
  [STRIPE_SUBSCRIPTION_STATUS.TRIALING]: SubscriptionStatus.TRIALING,
  [STRIPE_SUBSCRIPTION_STATUS.PAUSED]: SubscriptionStatus.PAUSED,
  // Chưa từng thanh toán thành công lần nào – KHÔNG phải PAST_DUE (đang trễ hạn).
  // Off-session làm trạng thái này trở nên thường xuyên: thẻ bị từ chối hoặc cần 3DS.
  [STRIPE_SUBSCRIPTION_STATUS.INCOMPLETE]: SubscriptionStatus.INCOMPLETE,
  [STRIPE_SUBSCRIPTION_STATUS.INCOMPLETE_EXPIRED]: SubscriptionStatus.EXPIRED,
};

/**
 * Trạng thái PaymentIntent của Stripe → trạng thái off-session của hệ thống.
 * `requires_confirmation` gộp vào `REQUIRES_ACTION`: cả hai đều cần client xác nhận.
 */
const OFF_SESSION_STATUS_MAP: Record<string, OffSessionStatus> = {
  [STRIPE_PAYMENT_INTENT_STATUS.SUCCEEDED]: OFF_SESSION_STATUS.SUCCEEDED,
  [STRIPE_PAYMENT_INTENT_STATUS.PROCESSING]: OFF_SESSION_STATUS.PROCESSING,
  [STRIPE_PAYMENT_INTENT_STATUS.REQUIRES_ACTION]: OFF_SESSION_STATUS.REQUIRES_ACTION,
  [STRIPE_PAYMENT_INTENT_STATUS.REQUIRES_CONFIRMATION]: OFF_SESSION_STATUS.REQUIRES_ACTION,
  [STRIPE_PAYMENT_INTENT_STATUS.REQUIRES_PAYMENT_METHOD]: OFF_SESSION_STATUS.REQUIRES_PAYMENT_METHOD,
};

function toOffSessionStatus(stripeStatus?: string | null): OffSessionStatus {
  return (
    OFF_SESSION_STATUS_MAP[stripeStatus ?? ""] ?? OFF_SESSION_STATUS.REQUIRES_PAYMENT_METHOD
  );
}

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

  async createOffSessionSubscription(
    params: CreateOffSessionSubscriptionParams,
  ): Promise<OffSessionSubscriptionResult> {
    const sub = await this.stripe.subscriptions.create({
      customer: params.customerId,
      items: [{ price: params.priceId }],
      default_payment_method: params.paymentMethodId,
      payment_behavior: STRIPE_PAYMENT_BEHAVIOR.ALLOW_INCOMPLETE,
      off_session: true,
      metadata: params.metadata,
      expand: [STRIPE_EXPAND.LATEST_INVOICE_PAYMENT_INTENT],
    });

    const intent = this.extractInvoicePaymentIntent(sub.latest_invoice);
    this.logger.log(
      `Created off-session subscription ${sub.id} for customer ${params.customerId} (status: ${sub.status})`,
    );

    return {
      subscription: this.mapSubscription(sub),
      paymentIntentId: intent?.id ?? null,
  
      status:
        sub.status === STRIPE_SUBSCRIPTION_STATUS.ACTIVE
          ? OFF_SESSION_STATUS.SUCCEEDED
          : toOffSessionStatus(intent?.status),
      clientSecret: intent?.client_secret ?? null,
    };
  }

  async createOffSessionPayment(
    params: CreateOffSessionPaymentParams,
  ): Promise<OffSessionPaymentResult> {
    try {
      const intent = await this.stripe.paymentIntents.create({
        amount: params.amount,
        currency: params.currency,
        customer: params.customerId,
        payment_method: params.paymentMethodId,
        description: params.description,
        metadata: params.metadata,
        confirm: true,
        off_session: true,
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: STRIPE_ALLOW_REDIRECTS.NEVER,
        },
      });

      return {
        paymentIntentId: intent.id,
        status: toOffSessionStatus(intent.status),
        clientSecret: intent.client_secret,
      };
    } catch (error) {
      const intent = (error as Stripe.StripeRawError)?.payment_intent;
      if (!intent) {
        this.logger.error(`Failed to create off-session payment: ${error}`);
        throw new BadRequestException("Failed to charge the saved payment method");
      }

      this.logger.warn(
        `Off-session payment ${intent.id} needs attention: ${intent.status} ` +
          `(${(error as Stripe.StripeRawError).code})`,
      );

      return {
        paymentIntentId: intent.id,
        status: toOffSessionStatus(intent.status),
        clientSecret: intent.client_secret ?? null,
      };
    }
  }

  async createBillingPortalSession(customerId: string, returnUrl?: string): Promise<BillingPortalSession> {
    try {
      const configuration = this.configService.get<string>("STRIPE_PORTAL_CONFIGURATION_ID");

      const session = await this.stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl || this.configService.get<string>("STRIPE_SUCCESS_URL", "http://localhost:3000"),
        ...(configuration ? { configuration } : {}),
      });
      return { url: session.url };
    } catch (error) {
      this.logger.error(`Failed to create billing portal session: ${error}`);
      throw new BadRequestException("Failed to create billing portal session");
    }
  }

  async createSetupIntent(customerId: string): Promise<SetupIntentResult> {
    const setupIntent = await this.stripe.setupIntents.create({
      customer: customerId,
      usage: STRIPE_SETUP_INTENT_USAGE.OFF_SESSION,
      payment_method_types: [STRIPE_PAYMENT_METHOD_TYPE.CARD],
    });

    this.logger.log(`Created setup intent ${setupIntent.id} for customer ${customerId}`);
    return { id: setupIntent.id, clientSecret: setupIntent.client_secret };
  }

  async getPaymentMethod(paymentMethodId: string): Promise<PaymentMethodDetails | null> {
    try {
      const paymentMethod = await this.stripe.paymentMethods.retrieve(paymentMethodId);
      return this.mapPaymentMethod(paymentMethod);
    } catch (error) {
      if ((error as Stripe.StripeRawError)?.code === STRIPE_ERROR_CODE.RESOURCE_MISSING) {
        return null;
      }
      throw error;
    }
  }

  async listPaymentMethods(customerId: string): Promise<PaymentMethodDetails[]> {
    const paymentMethods = await this.stripe.paymentMethods.list({
      customer: customerId,
      type: STRIPE_PAYMENT_METHOD_TYPE.CARD,
    });
    return paymentMethods.data.map(pm => this.mapPaymentMethod(pm));
  }

  async detachPaymentMethod(paymentMethodId: string): Promise<void> {
    try {
      await this.stripe.paymentMethods.detach(paymentMethodId);
      this.logger.log(`Detached payment method ${paymentMethodId}`);
    } catch (error) {
      if ((error as Stripe.StripeRawError)?.code === STRIPE_ERROR_CODE.RESOURCE_MISSING) {
        return;
      }
      throw error;
    }
  }

  async setDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
    await this.stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    this.logger.log(`Default payment method of customer ${customerId} → ${paymentMethodId}`);
  }

  async getDefaultPaymentMethodId(customerId: string): Promise<string | null> {
    const customer = await this.stripe.customers.retrieve(customerId);
    if ((customer as Stripe.DeletedCustomer).deleted) return null;

    const defaultPaymentMethod = (customer as Stripe.Customer).invoice_settings
      ?.default_payment_method;

    if (!defaultPaymentMethod) return null;
    return typeof defaultPaymentMethod === "string"
      ? defaultPaymentMethod
      : defaultPaymentMethod.id;
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

  mapRawPaymentMethod(rawPaymentMethod: unknown): PaymentMethodDetails {
    return this.mapPaymentMethod(rawPaymentMethod as Stripe.PaymentMethod);
  }

  private mapPaymentMethod(paymentMethod: Stripe.PaymentMethod): PaymentMethodDetails {
    const card = paymentMethod.card;
    return {
      id: paymentMethod.id,
    
      customerId:
        typeof paymentMethod.customer === 'string'
          ? paymentMethod.customer
          : (paymentMethod.customer?.id ?? null),
      brand: card?.brand ?? null,
      last4: card?.last4 ?? null,
      expMonth: card?.exp_month ?? null,
      expYear: card?.exp_year ?? null,
      fingerprint: card?.fingerprint ?? null,
    };
  }

  private extractInvoicePaymentIntent(
    latestInvoice: Stripe.Subscription['latest_invoice'],
  ): { id: string | null; status?: string | null; client_secret?: string | null } | null {
    if (!latestInvoice || typeof latestInvoice === 'string') return null;

    const paymentIntent = (latestInvoice as any).payment_intent;
    if (paymentIntent && typeof paymentIntent !== 'string') {
      return paymentIntent as Stripe.PaymentIntent;
    }

    const confirmationSecret = (latestInvoice as any).confirmation_secret;
    if (confirmationSecret?.client_secret) {
      return {
        id: typeof paymentIntent === 'string' ? paymentIntent : null,
        status: null,
        client_secret: confirmationSecret.client_secret,
      };
    }

    return null;
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