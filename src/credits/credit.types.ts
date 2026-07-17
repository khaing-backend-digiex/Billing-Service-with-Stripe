import { CreditGrantSourceType, SubscriptionStatus } from '@prisma/client';

export const ADDON_LIVE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
];


export const SUBSCRIPTION_SOURCES: CreditGrantSourceType[] = [
  CreditGrantSourceType.SUBSCRIPTION_ALLOCATION,
  CreditGrantSourceType.SUBSCRIPTION_RESET,
];

export const isSubscriptionSource = (
  sourceType: CreditGrantSourceType | null | undefined,
): boolean => !!sourceType && SUBSCRIPTION_SOURCES.includes(sourceType);


export const isAddonUsable = (
  isFree: boolean | null | undefined,
  status: SubscriptionStatus | null | undefined,
): boolean => isFree === false && !!status && ADDON_LIVE_STATUSES.includes(status);

export interface GrantSubscriptionCmd {
  userId: string;
  productId: string;
  amount: number;
  description: string;
  subscriptionId: string;
  invoiceId?: string;
  sourceType: CreditGrantSourceType;
  idempotencyKey: string;
  expiresAt?: Date;
}

export interface RevokeSubscriptionCmd {
  userId: string;
  productId: string;
  description: string;
  subscriptionId: string;
  invoiceId?: string;
  idempotencyKey: string;
}

export interface ResetSubscriptionCmd {
  userId: string;
  productId: string;
  amount: number;
  grantDescription: string;
  revokeDescription: string;
  subscriptionId: string;
  idempotencyKey: string;
  expiresAt?: Date;
}

export interface GrantAddonCmd {
  userId: string;
  productId: string;
  amount: number;
  description: string;
  paymentId: string;
  idempotencyKey: string;
  expiresAt?: Date;
}

export interface ConsumeCmd {
  userId: string;
  productId: string;
  amount: number;
  description: string;
  referenceId: string;
  idempotencyKey: string;
}

export interface AdjustCmd {
  userId: string;
  productId: string;
  sourceType: CreditGrantSourceType;
  amount: number;
  description: string;
  idempotencyKey: string;
}

export interface ConsumeResult {
  allocations: { sourceType: CreditGrantSourceType; amount: number; grantId: string }[];
  totalAllocated: number;
  remainingSubscription: number;
  remainingAddon: number;
}

export interface AllocationSource {
  grantId: string;
  sourceType: CreditGrantSourceType;
  available: number;
}

export interface AllocationResult {
  allocations: { grantId: string; sourceType: CreditGrantSourceType; amount: number }[];
  totalAllocated: number;
  shortfall: number;
}

export interface UserPackageStatus {
  plan: string;
  pricingOption: string;
  nextBillingDate: Date | null;
  subscriptionCredits: number;
  addonCredits: number;
  addonIsActive: boolean;
}

export const KEY_SEPARATOR = ':';

const KEY_SCOPE = {
  SUBSCRIPTION: 'sub',
  PAYMENT_INTENT: 'pi',
  REQUEST: 'req',
} as const;

const KEY_ACTION = {
  PERIOD: 'period',
  RESET: 'reset',
  REVOKE: 'revoke',
  GRANT: 'grant',
  CONSUME: 'consume',
} as const;

const join = (...parts: string[]) => parts.join(KEY_SEPARATOR);

export const creditKey = {
  subscriptionPeriod: (subscriptionId: string, periodStart: Date) =>
    join(KEY_SCOPE.SUBSCRIPTION, subscriptionId, KEY_ACTION.PERIOD, periodStart.toISOString()),
  subscriptionReset: (subscriptionId: string, nextCreditResetAt: Date) =>
    join(KEY_SCOPE.SUBSCRIPTION, subscriptionId, KEY_ACTION.RESET, nextCreditResetAt.toISOString()),
  subscriptionRevoke: (subscriptionId: string, providerSubscriptionId: string) =>
    join(KEY_SCOPE.SUBSCRIPTION, subscriptionId, KEY_ACTION.REVOKE, providerSubscriptionId),
  addonPurchase: (providerPaymentId: string) =>
    join(KEY_SCOPE.PAYMENT_INTENT, providerPaymentId),
  consume: (userId: string, productId: string, requestId: string) =>
    join(KEY_SCOPE.REQUEST, userId, productId, requestId, KEY_ACTION.CONSUME),
  revokeStep: (baseKey: string) => join(baseKey, KEY_ACTION.REVOKE),
  grantStep: (baseKey: string) => join(baseKey, KEY_ACTION.GRANT),
  grantStepItem: (baseKey: string, grantId: string) => join(baseKey, grantId),
} as const;
