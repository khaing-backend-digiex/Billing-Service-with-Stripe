# Code Review — Delta Report (What Changed & What Remains)

## Changes Detected Since Last Review

### New Files
| File | Purpose |
|------|---------|
| [provisioning.module.ts](file:///d:/Down/JWT_DB_Demo/src/provisioning/provisioning.module.ts) | New `ProvisioningModule` |
| [user-provisioning.service.ts](file:///d:/Down/JWT_DB_Demo/src/provisioning/user-provisioning.service.ts) | User creation + Stripe customer + free plan setup with rollback |

### Significantly Changed Files
| File | What Changed |
|------|-------------|
| [stripe.service.ts](file:///d:/Down/JWT_DB_Demo/src/stripe/stripe.service.ts) | Added `ensureCustomerId`, `ensureValidCustomerId`, `createAndPersistCustomer`, `cleanupCustomer`, `enqueueCustomerCleanup` — now has real orchestration logic |
| [users.service.ts](file:///d:/Down/JWT_DB_Demo/src/users/users.service.ts) | Completely refactored — removed `createUser`, `ensureStripeCustomerId`. Added `createUserRecord`, `findIncompleteOnboardingUsers`. Now a clean data-access layer |
| [users.module.ts](file:///d:/Down/JWT_DB_Demo/src/users/users.module.ts) | Removed `forwardRef(() => StripeModule)` — circular dependency eliminated ✅ |
| [auth.service.ts](file:///d:/Down/JWT_DB_Demo/src/auth/auth.service.ts) | Now uses `UserProvisioningService.createUser()` instead of `UsersService.createUser()` |
| [auth.module.ts](file:///d:/Down/JWT_DB_Demo/src/auth/auth.module.ts) | Added `ProvisioningModule` import |
| [free-plan-reconciliation.cron.ts](file:///d:/Down/JWT_DB_Demo/src/cron/free-plan-reconciliation.cron.ts) | Major refactor — uses `ReconcileOutcome` enum, extracted `reconcileUser` and `healFromStripe` helper methods, uses `stripeService.ensureValidCustomerId()` |
| [app.module.ts](file:///d:/Down/JWT_DB_Demo/src/app.module.ts) | Added `ProvisioningModule`, fixed `AuthModule` import path |
| [invoice-paid.strategy.ts](file:///d:/Down/JWT_DB_Demo/src/stripe/webhook/strategies/invoice-paid.strategy.ts) | Subscription upsert now has a proper `update` branch (sets status, pricingOptionId, credits, etc.) |

### Unchanged Files (Relevant to Review)
All other files: `stripe.adapter.ts`, `payment-adapter.interface.ts`, `customer.subscription.updated.ts`, `customer.subscription.deleted.ts`, `pricing.service.ts`, `schema.prisma`, `users.controller.ts`

---

## Issue-by-Issue Status

### 🔴 Bugs & Logic Errors

| ID | Issue | Status | Details |
|----|-------|--------|---------|
| **BUG-1** | Invoice created as `OPEN` in `invoice.paid` handler | 🟡 **Partially Fixed** | The `update` branch now sets `status: ACTIVE`, `pricingOptionId`, `credits`, etc. on the **subscription** — but the **invoice** upsert still creates with `status: InvoiceStatus.OPEN` ([L107](file:///d:/Down/JWT_DB_Demo/src/stripe/webhook/strategies/invoice-paid.strategy.ts#L107)) and `update: {}` ([L110](file:///d:/Down/JWT_DB_Demo/src/stripe/webhook/strategies/invoice-paid.strategy.ts#L110)). The invoice row is never marked PAID. |
| **BUG-2** | Double credit granting (strategy vs sync service) | 🔴 **Still Present** | `InvoicePaidStrategy` still always grants credits without the `claimed.count === 0` idempotency guard that `PaidInvoiceSyncService` has ([L109-L121](file:///d:/Down/JWT_DB_Demo/src/stripe/sync/paid-invoice-sync.service.ts#L109-L121)). |
| **BUG-3** | Payment recovery detection broken (filters by `ACTIVE` only) | 🔴 **Still Present** | [customer.subscription.updated.ts L64-67](file:///d:/Down/JWT_DB_Demo/src/stripe/webhook/strategies/customer.subscription.updated.ts#L64-L67) still queries `status: SubscriptionStatus?.ACTIVE`. `previousStatus` can never be `PAST_DUE`. |
| **BUG-4** | Unused `rxjs` Subscription import | 🔴 **Still Present** | [customer.subscription.updated.ts L14](file:///d:/Down/JWT_DB_Demo/src/stripe/webhook/strategies/customer.subscription.updated.ts#L14) — `import { Subscription } from "rxjs"` still there. |
| **BUG-5** | `subscription.deleted` stale data race condition | 🔴 **Still Present** | [customer.subscription.deleted.ts L31-L87](file:///d:/Down/JWT_DB_Demo/src/stripe/webhook/strategies/customer.subscription.deleted.ts#L31-L87) — subscription fetched before transaction, stale check at L82. |
| **BUG-6** | Fragile undocumented price extraction in `InvoicePaidStrategy` | 🔴 **Still Present** | [invoice-paid.strategy.ts L48](file:///d:/Down/JWT_DB_Demo/src/stripe/webhook/strategies/invoice-paid.strategy.ts#L48) — still uses `(lineToUse as any)?.pricing?.price_details?.price` instead of `lineToUse?.price?.id`. |

---

### 🔴 Security Issues

| ID | Issue | Status | Details |
|----|-------|--------|---------|
| **SEC-1** | No authentication factor (email-only login) | 🔴 **Still Present** | [auth.service.ts L19-39](file:///d:/Down/JWT_DB_Demo/src/auth/auth.service.ts#L19-L39) — still no password/OTP check. |
| **SEC-2** | Any USER can fetch any other user by ID | 🔴 **Still Present** | [users.controller.ts L41-48](file:///d:/Down/JWT_DB_Demo/src/users/users.controller.ts#L41-L48) — no ownership check. |

---

### 🟡 Code Quality Issues

| ID | Issue | Status | Details |
|----|-------|--------|---------|
| **CQ-1** | `PricingService` creates own Stripe instance | 🔴 **Still Present** | [pricing.service.ts L9-15](file:///d:/Down/JWT_DB_Demo/src/pricing/pricing.service.ts#L9-L15) |
| **CQ-2** | `StripeAdapter` contains business/DB logic | 🔴 **Still Present** | [stripe.adapter.ts L66-72, L122-140, L226-235](file:///d:/Down/JWT_DB_Demo/src/stripe/adapter/stripe.adapter.ts#L66-L72) — still queries Prisma |
| **CQ-3** | `StripeService` is a pure pass-through | ✅ **Fixed** | `StripeService` now has real orchestration: `ensureCustomerId`, `ensureValidCustomerId`, `createAndPersistCustomer`, `cleanupCustomer`, `enqueueCustomerCleanup` |
| **CQ-4** | Inconsistent import paths | 🔴 **Still Present** | `@/database/prisma.service` vs `../../../database/prisma.service` vs `src/common/constants/plan.constants` |
| **CQ-5** | Inconsistent file naming in webhook strategies | 🔴 **Still Present** | Mix of `invoice-paid.strategy.ts` and `customer.subscription.updated.ts` |
| **CQ-6** | Empty string fallback for Stripe key | 🔴 **Still Present** | [stripe.adapter.ts L23](file:///d:/Down/JWT_DB_Demo/src/stripe/adapter/stripe.adapter.ts#L23), [pricing.service.ts L15](file:///d:/Down/JWT_DB_Demo/src/pricing/pricing.service.ts#L15) |
| **CQ-7** | `console.error` instead of Logger in PricingService | 🔴 **Still Present** | [pricing.service.ts L78, L114](file:///d:/Down/JWT_DB_Demo/src/pricing/pricing.service.ts#L78) |
| **CQ-8** | `deleteUser` has no cascade handling | 🔴 **Still Present** | [users.service.ts L80-82](file:///d:/Down/JWT_DB_Demo/src/users/users.service.ts#L80-L82) — still a bare `prisma.user.delete()`. Note: `UserProvisioningService.rollbackProvisionedUser` has proper cleanup, but `deleteUser` (called by admin endpoint) does not. |
| **CQ-9** | Dead `AppConfigModule` import | 🔴 **Still Present** | [app.module.ts L5](file:///d:/Down/JWT_DB_Demo/src/app.module.ts#L5) — imported but not used in `imports` array |
| **CQ-10** | `CreateCustomerDto` missing `@ApiPropertyOptional` usage | 🔴 **Still Present** | Imported but never applied |
| **CQ-11** | `.env.example` duplicate `DB_SYNCHRONIZE` | 🔴 **Still Present** |

---

### 🟢 Architecture Issues

| ID | Issue | Status | Details |
|----|-------|--------|---------|
| **ARCH-1** | Circular dep `UsersModule` ↔ `StripeModule` | ✅ **Fixed** | `UsersModule` no longer imports `StripeModule`. `UserProvisioningService` in a new `ProvisioningModule` handles the orchestration. Clean dependency: `ProvisioningModule → [UsersModule, StripeModule]` |
| **ARCH-2** | Overlapping `PaymentsController` and `StripeController` | 🔴 **Still Present** |
| **ARCH-3** | `CreditWallet.is_active` snake_case | 🔴 **Still Present** | [schema.prisma L91](file:///d:/Down/JWT_DB_Demo/prisma/schema.prisma#L91) |
| **ARCH-5** | No index on `providerSubscriptionId` | 🔴 **Still Present** | [schema.prisma L74](file:///d:/Down/JWT_DB_Demo/prisma/schema.prisma#L74) |

---

### 🟢 Minor Issues

| ID | Issue | Status | Details |
|----|-------|--------|---------|
| **MINOR-1** | Missing `subscription_data.metadata` in checkout | 🔴 **Still Present** |
| **MINOR-2** | No `CreditWallet` deactivation on cancel | 🔴 **Still Present** |
| **MINOR-3** | `providerSubscriptionId` not updated in invoice.paid | 🟡 **Partially Fixed** | The update branch now sets most fields but still doesn't update `providerSubscriptionId` |
| **MINOR-4** | `providerCustomerId` should be `@unique` | 🔴 **Still Present** | [schema.prisma L13](file:///d:/Down/JWT_DB_Demo/prisma/schema.prisma#L13) |
| **MINOR-5** | `RegisterDto.dateOfBirth` accepted but never stored | 🔴 **Still Present** |
| **MINOR-6** | `findActiveSubscription` doesn't paginate | 🔴 **Still Present** |

---

## New Issues Introduced by Changes

### NEW-1: Hardcoded Admin Email in `UserProvisioningService`

**File:** [user-provisioning.service.ts L45](file:///d:/Down/JWT_DB_Demo/src/provisioning/user-provisioning.service.ts#L45)

```typescript
const newAdmin = await this.provisionUser({
  email: "[EMAIL_ADDRESS]",  // ← Hardcoded placeholder
  name: "Admin",
  roles: ["admin"],
});
```

The admin email is hardcoded as a placeholder (`[EMAIL_ADDRESS]`). This should come from environment config (`ADMIN_EMAIL`). If this runs in production, it'll create an admin with a literally unusable email.

---

## Summary

| Category | Total | Fixed | Partially Fixed | Remaining |
|----------|-------|-------|-----------------|-----------|
| 🔴 **Bugs** | 6 | 0 | 1 (BUG-1) | 5 |
| 🔴 **Security** | 2 | 0 | 0 | 2 |
| 🟡 **Code Quality** | 11 | 1 (CQ-3) | 0 | 10 |
| 🟢 **Architecture** | 4 | 1 (ARCH-1) | 0 | 3 |
| 🟢 **Minor** | 6 | 0 | 1 (MINOR-3) | 5 |
| 🆕 **New Issues** | 1 | — | — | 1 |
| **TOTAL** | **30** | **2** | **2** | **26** |

---

## What Was Improved (Positive Changes) ✅

1. **Circular dependency eliminated** — `UsersModule` no longer imports `StripeModule`; extracted to `ProvisioningModule`
2. **`StripeService` now has real value** — customer lifecycle management with rollback and cleanup queue
3. **`UsersService` is now a clean data layer** — removed Stripe concerns, added proper query methods
4. **`FreePlanReconciliationCron` significantly improved** — better structure with outcome tracking, helper methods, and uses `ensureValidCustomerId`
5. **User provisioning with rollback** — `UserProvisioningService` handles the create-customer → subscribe-free flow atomically with cleanup on failure
6. **Admin seeding on bootstrap** — convenient but needs config-driven email

---

## Priority Remaining Fixes

| Priority | Issue | Why |
|----------|-------|-----|
| **P0** | **SEC-1**: Add real authentication | Anyone can impersonate any user |
| **P0** | **BUG-1 + BUG-2**: Fix invoice status + deduplicate credits | Money bug |
| **P1** | **BUG-3**: Fix payment recovery detection | Feature completely broken |
| **P1** | **BUG-6**: Fix fragile price extraction | Will break on Stripe API updates |
| **P1** | **NEW-1**: Use env config for admin email | Broken in production |
| **P2** | **CQ-1 + CQ-2**: Unify Stripe through adapter, remove DB from adapter | Architecture |
| **P2** | **CQ-8**: Add cascade to `deleteUser` | Will crash in production |
| **P3** | **BUG-4**: Remove unused RxJS import | Cleanup |
| **P3** | **MINOR-4**: Add `@unique` to `providerCustomerId` | Data integrity |
| **P3** | All remaining CQ + MINOR items | Polish |
