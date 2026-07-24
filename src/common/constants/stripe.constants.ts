export const STRIPE_ERROR_CODE = {
  RESOURCE_MISSING: "resource_missing",
} as const;

export const STRIPE_SUBSCRIPTION_STATUS = {
  ACTIVE: "active",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
  UNPAID: "unpaid",
  TRIALING: "trialing",
  PAUSED: "paused",
  INCOMPLETE: "incomplete",
  INCOMPLETE_EXPIRED: "incomplete_expired",
} as const;

export const STRIPE_SUBSCRIPTION_LIST_STATUS = {
  ALL: "all",
} as const;

export const STRIPE_INVOICE_STATUS = {
  PAID: "paid",
} as const;

export const STRIPE_CANCELLATION_REASON = {
  PAYMENT_FAILED: "payment_failed",
} as const;

export const STRIPE_PAYMENT_INTENT_STATUS = {
  SUCCEEDED: "succeeded",
  PROCESSING: "processing",
  REQUIRES_ACTION: "requires_action",
  REQUIRES_CONFIRMATION: "requires_confirmation",
  REQUIRES_PAYMENT_METHOD: "requires_payment_method",
} as const;

export const STRIPE_PAYMENT_METHOD_TYPE = {
  CARD: "card",
} as const;

export const STRIPE_SETUP_INTENT_USAGE = {
  OFF_SESSION: "off_session",
} as const;

export const STRIPE_PAYMENT_BEHAVIOR = {
  ALLOW_INCOMPLETE: "allow_incomplete",
} as const;

export const STRIPE_ALLOW_REDIRECTS = {
  NEVER: "never",
} as const;

export const STRIPE_PRORATION_BEHAVIOR = {
  CREATE_PRORATIONS: "create_prorations",
  ALWAYS_INVOICE: "always_invoice",
  NONE: "none",
} as const;

export const STRIPE_BILLING_CYCLE_ANCHOR = {
  NOW: "now",
} as const;

export const STRIPE_BILLING_REASON = {
  SUBSCRIPTION_CREATE: "subscription_create",
  SUBSCRIPTION_UPDATE: "subscription_update",
} as const;

export const STRIPE_INVOICE_LINE_TYPE = {
  SUBSCRIPTION: "subscription",
} as const;

export const STRIPE_EXPAND = {
  LATEST_INVOICE_PAYMENT_INTENT: "latest_invoice.payment_intent",
} as const;

export const STRIPE_METADATA_KEY = {
  USER_ID: "userId",
  ADDON_PACKAGE_ID: "addonPackageId",
} as const;

export const STRIPE_LIST_LIMIT = {
  MAX: 100,
  LATEST_ONLY: 1,
} as const;

export const STRIPE_WEBHOOK_EVENT = {
  SETUP_INTENT_SUCCEEDED: "setup_intent.succeeded",
  SETUP_INTENT_SETUP_FAILED: "setup_intent.setup_failed",
  PAYMENT_METHOD_ATTACHED: "payment_method.attached",
  PAYMENT_METHOD_UPDATED: "payment_method.updated",
  PAYMENT_METHOD_DETACHED: "payment_method.detached",
  PAYMENT_INTENT_SUCCEEDED: "payment_intent.succeeded",
  PAYMENT_INTENT_PAYMENT_FAILED: "payment_intent.payment_failed",
  INVOICE_PAID: "invoice.paid",
  INVOICE_PAYMENT_FAILED: "invoice.payment_failed",
  INVOICE_PAYMENT_ACTION_REQUIRED: "invoice.payment_action_required",
  CUSTOMER_SUBSCRIPTION_UPDATED: "customer.subscription.updated",
  CUSTOMER_SUBSCRIPTION_DELETED: "customer.subscription.deleted",
} as const;
