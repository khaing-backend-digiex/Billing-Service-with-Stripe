import { ReferenceType } from '@prisma/client';

export type CreditBucket = typeof ReferenceType.SUBSCRIPTION | typeof ReferenceType.ADDON_PURCHASE;

export interface GrantSubscriptionCmd {
  userId: string;
  amount: number;
  description: string;
  referenceId: string;
  idempotencyKey: string;
}

export interface RevokeSubscriptionCmd {
  userId: string;
  description: string;
  referenceId: string;
  idempotencyKey: string;
}

export interface GrantAddonCmd {
  userId: string;
  amount: number;
  description: string;
  referenceId: string;
  idempotencyKey: string;
}

export interface ConsumeCmd {
  userId: string;
  amount: number;
  description: string;
  referenceId: string;
  idempotencyKey: string;
}

export interface AdjustCmd {
  userId: string;
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
