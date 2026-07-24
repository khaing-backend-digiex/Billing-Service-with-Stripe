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
} from './payment.types';

export interface IPaymentAdapter {

  createCustomer(email: string, name?: string, metadata?: Record<string, string>): Promise<PaymentCustomer>;
  deleteCustomer(customerId: string): Promise<void>;
  getCustomer(customerId: string): Promise<PaymentCustomer | null>;
  customerExists(customerId: string): Promise<boolean>;

  createSubscription(customerId: string, priceId: string): Promise<PaymentSubscription>;
  createOffSessionSubscription(params: CreateOffSessionSubscriptionParams): Promise<OffSessionSubscriptionResult>;
  cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void>;
  cancelSubscriptionNow(subscriptionId: string): Promise<void>;
  downgradeSubscriptionToFree(subscriptionId: string, freePriceId: string): Promise<PaymentSubscription>;
  listSubscriptions(customerId: string): Promise<PaymentSubscription[]>;
  getLatestPaidInvoice(subscriptionId: string): Promise<PaymentInvoice | null>;

  createOffSessionPayment(params: CreateOffSessionPaymentParams): Promise<OffSessionPaymentResult>;
  createBillingPortalSession(customerId: string, returnUrl?: string): Promise<BillingPortalSession>;

  createSetupIntent(customerId: string): Promise<SetupIntentResult>;
  getPaymentMethod(paymentMethodId: string): Promise<PaymentMethodDetails | null>;
  listPaymentMethods(customerId: string): Promise<PaymentMethodDetails[]>;
  detachPaymentMethod(paymentMethodId: string): Promise<void>;
  setDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void>;
  getDefaultPaymentMethodId(customerId: string): Promise<string | null>;

  constructWebhookEvent(rawBody: Buffer, signature: string): WebhookEvent;
  mapRawSubscription(rawSubscription: unknown): PaymentSubscription;
  mapRawInvoice(rawInvoice: unknown): PaymentInvoice;
  mapRawPaymentMethod(rawPaymentMethod: unknown): PaymentMethodDetails;

  createProduct(name: string): Promise<string>;
  createRecurringPrice(productId: string, amount: number, currency: string, recurring: RecurringInterval): Promise<string>;
  createOneTimePrice(productId: string, amount: number, currency: string): Promise<string>;
  upgradeSubscriptionTier(subscriptionId: string, newPriceId: string): Promise<PaymentSubscription>;
  upgradeSubscriptionCycle(subscriptionId: string, newPriceId: string): Promise<PaymentSubscription>;
  previewUpgradeSubscriptionTier(customerId: string, subscriptionId: string, newPriceId: string): Promise<any>;
  previewUpgradeSubscriptionCycle(customerId: string, subscriptionId: string, newPriceId: string): Promise<any>;

}
