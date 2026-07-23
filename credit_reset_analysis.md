# Credit Reset Problem During Cycle Upgrade (Monthly → Yearly)

## The Core Dilemma

When a customer upgrades from **Monthly** to **Yearly** billing, there's a fundamental tension between two bad outcomes:

---

## What Actually Happens Today (Code Trace)

### Step 1: Stripe adapter resets the billing anchor

[stripe.adapter.ts#L524-L533](file:///d:/Down/JWT_DB_Demo/src/stripe/adapter/stripe.adapter.ts#L524-L533):
```typescript
billing_cycle_anchor: 'now',          // ← new 12-month period starts NOW
proration_behavior: 'always_invoice', // ← generates a proration invoice
```

### Step 2: The service sets `nextCreditResetAt = currentPeriodEnd` (12 months away)

[stripe.service.ts#L363](file:///d:/Down/JWT_DB_Demo/src/stripe/stripe.service.ts#L363):
```typescript
nextCreditResetAt: new Date(updatedStripeSub.currentPeriodEnd * 1000),
// currentPeriodEnd is NOW + 365 days!
```

### Step 3: Stripe fires `invoice.paid` with `billingReason: "subscription_update"`

[paid-invoice-sync.service.ts#L107](file:///d:/Down/JWT_DB_Demo/src/stripe/sync/paid-invoice-sync.service.ts#L107):
```typescript
const isCycleChange = paidInvoice.billingReason === "subscription_update";
```

### Step 4: Because `isCycleChange === true`, credits are **NOT** reset

[paid-invoice-sync.service.ts#L189-L218](file:///d:/Down/JWT_DB_Demo/src/stripe/sync/paid-invoice-sync.service.ts#L189-L218):
```typescript
const creditsGranted = isCycleChange ? 0 : (plan.creditPolicy?.creditAmount ?? 0);

if (!isCycleChange) {
  // revoke old credits
  // grant new credits   ← THIS IS SKIPPED FOR CYCLE CHANGES
}
```

### Step 5: `nextCreditResetAt` is recalculated from the new period

[paid-invoice-sync.service.ts#L90](file:///d:/Down/JWT_DB_Demo/src/stripe/sync/paid-invoice-sync.service.ts#L90):
```typescript
const nextCreditResetAt = addCalendarMonths(periodStart, resetMonths);
// periodStart = NOW, resetMonths = 1
// nextCreditResetAt = NOW + 1 month ✅
```

But then the service's direct write **overwrites** this with:
```typescript
nextCreditResetAt: new Date(updatedStripeSub.currentPeriodEnd * 1000)
// = NOW + 12 months ❌
```

### Step 6: Credit reset cron checks `nextCreditResetAt`

[credit-reset.cron.ts#L31](file:///d:/Down/JWT_DB_Demo/src/cron/credit-reset.cron.ts#L31):
```typescript
nextCreditResetAt: { lte: now },
```

But `nextCreditResetAt` is 12 months in the future, so **the cron never fires for this subscription** until the end of the yearly period.

---

## The Two Bad Scenarios

### Scenario A: Current behavior — Customer waits 12 months for credit reset

```
Timeline:
Day 1:    Monthly plan starts, 100 credits granted
Day 15:   Customer uses 80 credits (20 remaining)
Day 15:   Customer upgrades Monthly → Yearly
          → isCycleChange=true → credits NOT touched ✅ (keeps 20)
          → nextCreditResetAt set to Day 15 + 12 months ❌
          → Credit reset cron won't fire for 12 months
Day 45:   Customer has 0 credits left, expects monthly reset
          → NOTHING HAPPENS — next reset is in ~11 months
```

> [!CAUTION]
> The customer is paying for a plan that promises monthly credit resets (via `CreditPolicy.resetInterval = 'MONTHLY'`), but after upgrading to yearly billing, they won't get a single credit reset for 12 months. This is clearly wrong.

### Scenario B: If we added credit reset on cycle change

```
Timeline:
Day 1:    Monthly plan starts, 100 credits granted
Day 1:    Customer uses all 100 credits
Day 2:    Customer upgrades Monthly → Yearly
          → Credits reset → gets 100 fresh credits ❌ (exploit!)
          → Customer effectively got 200 credits in the first month
Day 32:   Monthly reset → another 100 credits
          → Total: 300 credits in first 32 days
```

> [!WARNING]
> This is exploitable. A customer can always burn all credits, upgrade cycle, get a fresh reset, and end up with more credits than they should have.

---

## Root Cause

The root cause is that **`nextCreditResetAt` is being tied to the billing period end** instead of being on its own monthly cadence. The billing cycle (Monthly vs Yearly) should only control **payment frequency**, not credit reset frequency. Credits should always reset monthly per the `CreditPolicy`.

There are two competing writes:

| Writer | Sets `nextCreditResetAt` to | Correct? |
|---|---|---|
| `stripe.service.ts` (direct write, L363) | `currentPeriodEnd` (12 months) | ❌ |
| `paid-invoice-sync.service.ts` (webhook, L90) | `addCalendarMonths(periodStart, 1)` (1 month) | ✅ |

**The problem:** The service's direct write wins because of the race condition from the previous review (Issue #2). Even if the webhook arrives second, the service write at L363 sets it to 12 months. And even if the webhook's write at L153 overwrites it to 1 month, the service might re-overwrite it depending on timing.

---

## Proposed Fix

### 1. Don't reset credits on cycle change (current behavior is correct here)

The `isCycleChange` guard at [L189-L218](file:///d:/Down/JWT_DB_Demo/src/stripe/sync/paid-invoice-sync.service.ts#L189-L218) is correct — we should NOT revoke+re-grant credits when just changing billing cycle. The customer keeps their current credit balance.

### 2. Fix `nextCreditResetAt` to stay on monthly cadence

In [stripe.service.ts#L356-L367](file:///d:/Down/JWT_DB_Demo/src/stripe/stripe.service.ts#L356-L367), instead of:

```typescript
nextCreditResetAt: new Date(updatedStripeSub.currentPeriodEnd * 1000),
```

Calculate the next monthly reset from the **current** `nextCreditResetAt`:

```typescript
// Keep the existing monthly reset schedule — don't push to period end
// Only recalculate if the current reset is in the past
nextCreditResetAt: currentSub.nextCreditResetAt > new Date()
  ? currentSub.nextCreditResetAt   // keep existing schedule
  : addCalendarMonths(new Date(), 1), // fallback: 1 month from now
```

### 3. Fix `paid-invoice-sync.service.ts` for cycle changes too

At [L146-L158](file:///d:/Down/JWT_DB_Demo/src/stripe/sync/paid-invoice-sync.service.ts#L146-L158), when `isCycleChange` is true, preserve the existing `nextCreditResetAt` instead of overwriting:

```typescript
await tx.subscription.update({
  where: { id: subscription.id },
  data: {
    status: SubscriptionStatus.ACTIVE,
    pricingOptionId: pricingOption.id,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    // For cycle changes, keep the monthly credit schedule
    ...(isCycleChange
      ? {}  // don't touch nextCreditResetAt
      : { nextCreditResetAt }),
    ...(shouldRepoint ? { providerSubscriptionId: stripeSubscriptionId } : {}),
  },
});
```

### 4. Fix the credit-reset cron's skip condition

At [credit-reset.cron.ts#L68-L73](file:///d:/Down/JWT_DB_Demo/src/cron/credit-reset.cron.ts#L68-L73):
```typescript
if (newNextReset > subscription.currentPeriodEnd) {
  // This skip is correct for monthly billing but wrong for yearly —
  // yearly subscriptions SHOULD get monthly resets within their 12-month period
}
```

This condition is actually fine — as long as `nextCreditResetAt` stays on a monthly cadence, `newNextReset` (= current + 1 month) will always be within the 12-month `currentPeriodEnd`. The skip only triggers on the last month, which is correct (the renewal invoice handles that one).

---

## After Fix — Correct Behavior

```
Day 1:    Monthly plan, 100 credits, nextCreditResetAt = Feb 1
Day 15:   80 credits used (20 remaining)
Day 15:   Upgrade Monthly → Yearly
          → Credits NOT touched (keeps 20) ✅
          → nextCreditResetAt stays Feb 1 ✅ (not pushed to next year)
          → currentPeriodEnd = Jan 15 next year
Feb 1:    Credit reset cron fires
          → Revoke 20 remaining, grant 100 fresh ✅
          → nextCreditResetAt = Mar 1
Mar 1:    Credit reset cron fires again ✅
          → Monthly resets continue throughout the yearly billing period
```

---

## Summary of Changes Needed

| File | Change |
|---|---|
| [stripe.service.ts](file:///d:/Down/JWT_DB_Demo/src/stripe/stripe.service.ts#L356-L367) | Keep `nextCreditResetAt` on existing monthly cadence during cycle upgrade |
| [paid-invoice-sync.service.ts](file:///d:/Down/JWT_DB_Demo/src/stripe/sync/paid-invoice-sync.service.ts#L146-L158) | Don't overwrite `nextCreditResetAt` when `isCycleChange` is true |

Would you like me to implement these fixes?
