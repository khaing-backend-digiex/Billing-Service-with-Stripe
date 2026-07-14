import { SubscriptionStatus } from '@prisma/client';

export interface PaymentCustomer {
  id: string;
  email: string;
  name?: string | null;
  deleted?: boolean;
  metadata?: Record<string, string>;
}


export interface PaymentSubscription {
  id: string;
  customerId: string;
  status: SubscriptionStatus;
  items: PaymentSubscriptionItem[];
  currentPeriodStart: number;  
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  cancelAt?: number | null;
  trialStart?: number | null;
  trialEnd?: number | null;
  cancellationReason?: string | null;
  created: number;
}

export interface PaymentSubscriptionItem {
  priceId: string;
  currentPeriodStart: number;
  currentPeriodEnd: number;
}

export interface PaymentInvoice {
  id: string;
  customerId: string;
  subscriptionId?: string | null;
  amountDue: number;          
  amountPaid: number;
  currency: string;
  status: string;
  billingReason?: string | null;
  periodStart: number;
  periodEnd: number;
  dueDate?: number | null;
  attemptCount: number;
  nextPaymentAttempt?: number | null;
  paymentIntentId?: string | null;
  lines: PaymentInvoiceLine[];
}

export interface PaymentInvoiceLine {
  type: string;
  priceId?: string | null;
  subscriptionId?: string | null;
}

export interface CheckoutSession {
  id: string;
  url: string | null;
}

export interface PaymentIntentResult {
  id: string;
  clientSecret: string | null;
  amount: number;
  currency: string;
  status: string;
  metadata?: Record<string, string>;
}

export interface BillingPortalSession {
  url: string;
}

export interface WebhookEvent {
  id: string;
  type: string;
  data: unknown;     
  created: number;
}

export interface RecurringInterval {
  interval: 'day' | 'week' | 'month' | 'year';
  intervalCount: number;
}

export interface CreateCheckoutParams {
  customerId?: string;
  priceId: string;
  mode: 'payment' | 'subscription';
  metadata?: Record<string, string>;
  successUrl?: string;
  cancelUrl?: string;
  subscriptionMetadata?: Record<string, string>;
}

export interface CreatePaymentIntentParams {
  amount: number;
  currency: string;
  customerId?: string;
  description?: string;
  metadata?: Record<string, string>;
}
