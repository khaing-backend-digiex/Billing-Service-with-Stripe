
export const OFF_SESSION_STATUS = {
  SUCCEEDED: "succeeded",
  PROCESSING: "processing",
  REQUIRES_ACTION: "requires_action",
  REQUIRES_PAYMENT_METHOD: "requires_payment_method",
} as const;

export type OffSessionStatus =
  (typeof OFF_SESSION_STATUS)[keyof typeof OFF_SESSION_STATUS];
