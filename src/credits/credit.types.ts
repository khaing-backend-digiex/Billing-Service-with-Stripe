import { ReferenceType, SubscriptionStatus } from '@prisma/client';
import { PLAN_CODES } from '../common/constants/plan.constants';

export type CreditBucket = typeof ReferenceType.SUBSCRIPTION | typeof ReferenceType.ADDON_PURCHASE;

/** Gói trả phí đang dùng được. PAST_DUE KHÔNG nằm trong đây: đang nợ tiền thì khoá ví. */
export const ADDON_LIVE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
];

/**
 * Addon có tiêu được hay không là GIÁ TRỊ DẪN XUẤT từ gói hiện tại, không phải trạng thái
 * cần ai đó nhớ ghi.
 *
 * Trước đây nó là cột `CreditWallet.is_active`, bị ba webhook handler rời rạc cùng ghi
 * (`invoice.paid`, `subscription.deleted`, `subscription.updated`) ở ba transaction riêng.
 * Stripe không đảm bảo thứ tự giao event, nên giá trị cuối cùng phụ thuộc event nào về sau
 * chứ không phụ thuộc gói thật của user. Tệ hơn: `grantAddonCredits` tạo ví với
 * `is_active: false`, còn `invoice.paid` chỉ `updateMany` (không tạo row) – nên user mua addon
 * trước khi ví kịp tồn tại sẽ có credit KHÔNG BAO GIỜ tiêu được.
 *
 * Tính lúc đọc thì không còn writer → không còn race, không còn lỗi thứ tự. Số dư addon luôn
 * được GIỮ NGUYÊN khi huỷ gói; chỉ tạm khoá, và tự mở lại ngay khi user mua gói trả phí lần sau.
 */
export const isAddonUsable = (
  planCode: string | null | undefined,
  status: SubscriptionStatus | null | undefined,
): boolean =>
  !!planCode &&
  planCode !== PLAN_CODES.FREE &&
  !!status &&
  ADDON_LIVE_STATUSES.includes(status);

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

export interface ResetSubscriptionCmd {
  userId: string;
  amount: number;
  grantDescription: string;
  revokeDescription: string;
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
  /**
   * `userId` nằm trong khoá vì `requestId` do client tự đặt: hai user hoàn toàn có thể
   * chọn trùng chuỗi. Thiếu nó thì lần trừ credit của user thứ hai va vào unique constraint
   * rồi im lặng no-op, trong khi API vẫn trả success.
   */
  consume: (userId: string, requestId: string) =>
    join(KEY_SCOPE.REQUEST, userId, requestId, KEY_ACTION.CONSUME),
  revokeStep: (baseKey: string) => join(baseKey, KEY_ACTION.REVOKE),
  grantStep: (baseKey: string) => join(baseKey, KEY_ACTION.GRANT),
  bucketStep: (baseKey: string, bucket: string) => join(baseKey, bucket),
} as const;
