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

/**
 * Reset về allowance của kỳ mới = đốt phần dư rồi cấp mới.
 *
 * Gộp thành MỘT lệnh vì "revoke rồi grant" là một thuật toán duy nhất, trước đây bị chép ở
 * ba nơi (`invoice.paid`, cron reset, downgrade), mỗi nơi tự bịa khoá và `referenceId` riêng.
 * Caller chỉ cầm một `idempotencyKey`; hai khoá con do CreditService dẫn xuất.
 */
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

/**
 * Sinh `idempotencyKey` cho mọi lệnh credit — một nơi duy nhất.
 *
 * Khoá phải mang NGỮ NGHĨA NGHIỆP VỤ, không phải thời điểm chạy hay eventId: cron reset và
 * `invoice.paid` là hai event Stripe khác nhau, cả hai đều hợp lệ, nhưng cùng một kỳ chỉ
 * được cấp credit một lần. Khoá chính là thứ `CreditRepository.applyDelta` dựa vào
 * (unique index → P2002 → no-op), nên viết sai khoá = mất luôn chống trùng.
 */
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
  /** Cấp allowance cho một kỳ billing (`invoice.paid`). Một kỳ = một lần cấp. */
  subscriptionPeriod: (subscriptionId: string, periodStart: Date) =>
    join(KEY_SCOPE.SUBSCRIPTION, subscriptionId, KEY_ACTION.PERIOD, periodStart.toISOString()),

  /**
   * Reset giữa kỳ do cron.
   *
   * ⚠️ Mốc là `nextCreditResetAt`, KHÔNG phải `periodStart` và tuyệt đối không phải
   * `Date.now()`: gói năm có một `periodStart` nhưng reset credit 12 lần. Lấy sai mốc là
   * mất 11 lần reset; lấy theo thời điểm chạy thì khoá không chống trùng được gì cả.
   */
  subscriptionReset: (subscriptionId: string, nextCreditResetAt: Date) =>
    join(KEY_SCOPE.SUBSCRIPTION, subscriptionId, KEY_ACTION.RESET, nextCreditResetAt.toISOString()),

  /** Thu hồi credit khi gói kết thúc (huỷ / hết hạn / hạ về free). */
  subscriptionRevoke: (subscriptionId: string, providerSubscriptionId: string) =>
    join(KEY_SCOPE.SUBSCRIPTION, subscriptionId, KEY_ACTION.REVOKE, providerSubscriptionId),

  /** Mua addon: một PaymentIntent = một lần cộng credit. */
  addonPurchase: (providerPaymentId: string) =>
    join(KEY_SCOPE.PAYMENT_INTENT, providerPaymentId),

  /** Tiêu credit: khoá do CLIENT cấp — chỉ client biết retry nào là cùng một request. */
  consume: (requestId: string) =>
    join(KEY_SCOPE.REQUEST, requestId, KEY_ACTION.CONSUME),

  /**
   * "Reset về allowance" = HAI bút toán (revoke rồi grant), nên cần hai khoá dẫn xuất từ
   * cùng một khoá ngữ nghĩa. Nhờ vậy caller chỉ cầm một khoá và không thể lệch cặp.
   */
  revokeStep: (baseKey: string) => join(baseKey, KEY_ACTION.REVOKE),
  grantStep: (baseKey: string) => join(baseKey, KEY_ACTION.GRANT),
} as const;
