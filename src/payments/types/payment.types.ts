import { SubscriptionStatus } from '@prisma/client';
import { OffSessionStatus } from '../../common/constants/payment.constants';

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
  isProration?: boolean;
  periodStart: number;
  periodEnd: number;
}

export interface PaymentMethodDetails {
  id: string;
  customerId: string | null;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  fingerprint: string | null;
}

export interface SetupIntentResult {
  id: string;
  clientSecret: string | null;
}

export interface OffSessionPaymentResult {
  paymentIntentId: string | null;
  status: OffSessionStatus;
  clientSecret: string | null;
}

export interface OffSessionSubscriptionResult extends OffSessionPaymentResult {
  subscription: PaymentSubscription;
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

export interface CreateOffSessionSubscriptionParams {
  customerId: string;
  priceId: string;
  paymentMethodId: string;
  metadata?: Record<string, string>;
}

export interface CreateOffSessionPaymentParams {
  customerId: string;
  paymentMethodId: string;
  amount: number;
  currency: string;
  description?: string;
  metadata?: Record<string, string>;
}
