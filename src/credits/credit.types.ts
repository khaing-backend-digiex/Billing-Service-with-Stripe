import { ReferenceType } from '@prisma/client';

export type CreditBucket = typeof ReferenceType.SUBSCRIPTION | typeof ReferenceType.ADDON_PURCHASE;

export interface GrantSubscriptionCmd {
  userId: number;
  amount: number;
  description: string;
  referenceId: string;
  idempotencyKey: string;
}

export interface RevokeSubscriptionCmd {
  userId: number;
  description: string;
  referenceId: string;
  idempotencyKey: string;
}

export interface ResetSubscriptionCmd {
  userId: number;
  amount: number;
  grantDescription: string;
  revokeDescription: string;
  referenceId: string;
  idempotencyKey: string;
}

export interface GrantAddonCmd {
  userId: number;
  amount: number;
  description: string;
  referenceId: string;
  idempotencyKey: string;
}

export interface ConsumeCmd {
  userId: number;
  amount: number;
  description: string;
  referenceId: string;
  idempotencyKey: string;
}

export interface AdjustCmd {
  userId: number;
  bucket: CreditBucket;
  amount: number;
  description: string;
  idempotencyKey: string;
}

export interface CreditBalance {
  subscription: number;
  addon: number;
  addonActive: boolean;
  total: number;
}

export interface ConsumeResult {
  fromSubscription: number;
  fromAddon: number;
  remainingSubscription: number;
  remainingAddon: number;
}

export interface AllocationSource {
  bucket: CreditBucket;
  available: number;
}

export interface AllocationResult {
  allocations: { bucket: CreditBucket; amount: number }[];
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

const KEY_SEPARATOR = ':';

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
  consume: (requestId: string) =>
    join(KEY_SCOPE.REQUEST, requestId, KEY_ACTION.CONSUME),
  revokeStep: (baseKey: string) => join(baseKey, KEY_ACTION.REVOKE),
  grantStep: (baseKey: string) => join(baseKey, KEY_ACTION.GRANT),
} as const;
