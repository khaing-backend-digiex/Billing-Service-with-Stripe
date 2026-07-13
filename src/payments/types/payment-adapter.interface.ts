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
} from './payment.types';

export interface IPaymentAdapter {

  createCustomer(email: string, name?: string, metadata?: Record<string, string>): Promise<PaymentCustomer>;
  deleteCustomer(customerId: string): Promise<void>;
  getCustomer(customerId: string): Promise<PaymentCustomer | null>;
  customerExists(customerId: string): Promise<boolean>;

  createSubscription(customerId: string, priceId: string): Promise<PaymentSubscription>;
  cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void>;
  cancelSubscriptionNow(subscriptionId: string): Promise<void>;
  listSubscriptions(customerId: string): Promise<PaymentSubscription[]>;
  getLatestPaidInvoice(subscriptionId: string): Promise<PaymentInvoice | null>;

  createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutSession>;
  createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentResult>;
  createBillingPortalSession(customerId: string, returnUrl?: string): Promise<BillingPortalSession>;
  hasDefaultPaymentMethod(customerId: string): Promise<boolean>;

  constructWebhookEvent(rawBody: Buffer, signature: string): WebhookEvent;
  mapRawSubscription(rawSubscription: unknown): PaymentSubscription;
  mapRawInvoice(rawInvoice: unknown): PaymentInvoice;

  createProduct(name: string): Promise<string>;  // returns productId
  createRecurringPrice(productId: string, amount: number, currency: string, recurring: RecurringInterval): Promise<string>;  // returns priceId
  createOneTimePrice(productId: string, amount: number, currency: string): Promise<string>;  // returns priceId
  upgradeSubscriptionTier(subscriptionId: string, newPriceId: string): Promise<PaymentSubscription>;
  upgradeSubscriptionCycle(subscriptionId: string, newPriceId: string): Promise<PaymentSubscription>;
  previewUpgradeSubscriptionTier(customerId: string, subscriptionId: string, newPriceId: string): Promise<any>;
  previewUpgradeSubscriptionCycle(customerId: string, subscriptionId: string, newPriceId: string): Promise<any>;

}
