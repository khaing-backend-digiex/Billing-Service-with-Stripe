# Code Review — `feat/payment-method` (vs `origin/main`)

**Date:** 2026-07-13
**Scope:** credits (service/repository/keys), all webhook strategies, sync services, invoice/payment services, Stripe adapter, purchase endpoints, payment-method flows, crons, Prisma schema.

**Overall:** the architecture is sound — clear service ownership (`InvoiceService` owns `Invoice`, `PaymentService` owns `Payment`), CAS-based invoice claiming, semantic idempotency keys, webhook-driven state. But there are two Critical defects that can cancel a paying customer's live subscription or double-charge credits, and one design-level flaw in how idempotency no-ops interact with Postgres transactions.

---

## Critical

### C1. Stale `customer.subscription.updated` can repoint the local row and then cancel the user's live paid subscription

`src/stripe/sync/subscription-sync.service.ts:73-137`

**Why:** `syncFromStripe` upserts by `userId` and unconditionally overwrites `providerSubscriptionId` with the incoming event's sub id (line 97), then — outside the transaction — cancels whatever the row *used to* point to (lines 131–137). There is no guard that the incoming event is newer or that it belongs to the currently-pointed subscription. `PaidInvoiceSyncService` has exactly this guard (`isStale`, line 101); this service has none, and it's the one with a destructive Stripe side effect.

**Impact:** Stripe does not guarantee event ordering. Sequence: user upgrades, local row is repointed old-sub-X → new-sub-Y, old X is cancelled. A lagging `customer.subscription.updated` for X (any earlier update to X, delivered late) now arrives: the upsert repoints the row *back* to X with X's stale pricing/status, then `existing.providerSubscriptionId (Y) !== sub.id (X)` triggers `cancelSubscriptionNow(Y)` — **the system cancels the subscription the customer just paid for.** The subsequent `deleted(Y)` event finds no matching row, so nothing heals it. Customer charged, entitlement gone.

**Fix:** Before syncing, verify the event is for the subscription the row currently points to, or is strictly newer (compare `stripeSubscription.created`, or ignore events for sub ids ≠ current pointer unless they're a known upgrade path). Never derive a Stripe-side cancel from "local pointer differs" — cancel the old sub explicitly in the purchase/upgrade flow where intent is known, and make the sync path read-only with respect to Stripe. Do the cancel decision inside the same transaction snapshot, not from a pre-transaction read.

### C2. `consume` retry can double-deduct, and the consume idempotency key is not user-scoped

`src/credits/credit.service.ts:63-85`, `src/credits/credits.controller.ts:25`

**Why:** The ledger idempotency key is derived per-bucket: `` `${cmd.idempotencyKey}:${alloc.bucket}` `` (line 70), but the bucket split is recomputed from *current* balances on every call. A client retry (the exact scenario the DTO comment says this key exists for) re-allocates against post-consumption balances and can land on a bucket that was not used the first time — producing a brand-new key that passes the unique constraint.

**Impact:** Concrete case: subscription bucket has exactly 4 credits, addon has 10. `consume(4)` succeeds from the subscription bucket with key `K:SUBSCRIPTION`. The response times out; the client retries with the same key. Now sub=0, so allocation draws 4 from addon → key `K:ADDON_PURCHASE` → insert succeeds → **8 credits deducted for one request.** Separately, `creditKey.consume(dto.idempotencyKey)` contains no `userId`, so two users who happen to pick the same key collide: the second user's deduction silently no-ops (P2002 → `false`) while the API returns success — unmetered usage.

**Fix:** Make the request key the idempotency unit, not the (request, bucket) pair: check for an existing `CreditTransaction` with key prefix `= cmd.idempotencyKey` inside the locked transaction and return the recorded result if found, before allocating. Scope the key as `req:${userId}:${clientKey}:consume`.

### C3. Catching P2002 inside a shared Postgres transaction poisons the transaction — the "idempotent no-op" pattern doesn't work as designed

`src/credits/credit.repository.ts:70-78`, used inside shared transactions at `src/credits/credit.service.ts`, `src/stripe/sync/paid-invoice-sync.service.ts:116-229`

**Why:** `applyDelta` catches the unique violation and returns `false` so callers can continue. But on PostgreSQL, any statement error puts the *entire* transaction into an aborted state (25P02). Every subsequent statement in the same `$transaction` — the grant step after a duplicate revoke, the second bucket in `consume`, `subscriptionEvent.create` after a duplicate grant — fails with "current transaction is aborted", and a final `COMMIT` is silently converted to `ROLLBACK` while Prisma reports success. Note also that the balance `update` in `applyDelta` runs *before* the `create` that raises P2002; only the abort-and-rollback saves you from committing a balance change with no ledger row.

**Impact:** Every replay path that reaches a duplicate key mid-transaction turns into a 500 / FAILED webhook event instead of a graceful no-op, and paths where P2002 is the last statement commit-as-rollback while the code path (and the HTTP response) reports success with numbers that don't match the database. The test suite runs against a real DB but has no replayed-duplicate test (`credit.service.spec.ts`, `credits.e2e.spec.ts`), so this is currently unverified behavior at the heart of the idempotency design.

**Fix:** Either (a) check-before-insert: `SELECT 1 FROM "CreditTransaction" WHERE "idempotencyKey" = $1` inside the transaction (rows are never deleted, so read-then-insert under the caller's transaction plus the unique constraint as backstop is safe), or (b) wrap the insert in a savepoint (`SAVEPOINT` / `ROLLBACK TO SAVEPOINT`) so a P2002 doesn't abort the outer transaction. Then add an integration test that replays `invoice.paid` and a mixed-bucket consume retry against real Postgres.

---

## High

### H1. `revokeSubscriptionCredits` reads the balance without a lock — race with `consume` produces negative balances

`src/credits/credit.service.ts:171-192`

**Why:** Revoke is not "set balance to 0" — it is two separate steps: read the balance with a plain `findUnique` (no lock), then blindly `increment: -remaining` by that previously-read number. `consume` locks via `lockForConsume` (`SELECT ... FOR UPDATE`), but the lock only serializes consumers against *each other* — revoke never participates in the locking protocol.

**Impact:** Timeline on Postgres (READ COMMITTED):

```
t1  Consume tx A: lockForConsume → FOR UPDATE lock on the row, reads 100
t2  Revoke tx B:  findUnique reads 100
                  (plain MVCC read — it does NOT wait for A's lock)
t3  Tx A: UPDATE ... increment -30, COMMIT          → balance = 70
t4  Tx B: UPDATE ... increment -100
          (blocks on A's lock; once A commits it re-reads the NEW
           row value and applies the increment to it)
          70 + (-100) = -30, COMMIT                 → balance = -30
```

The crucial detail is at t4: in READ COMMITTED, a blocked `UPDATE` doesn't re-check anything when the lock is released — it applies the increment to the *latest committed* value. Revoke subtracts the stale number it read at t2 from a balance that has since shrunk. The ledger also drifts: revoke logs −100 but only removed 70 of real balance, so `SUM(amount)` no longer equals the stored balance — exactly the mismatch the reconciliation cron alarms on. (If revoke fully *commits* before consume starts, there is no problem — consume's locked read sees 0 and fails. The bug requires overlap.)

**Fix (either):**
1. In `revokeSubscriptionCredits`, read the balance with the same `SELECT ... FOR UPDATE` used by `lockForConsume`.
2. Preferred: make it atomic — `UPDATE "Subscription" SET "subscriptionCreditsRemaining" = 0 WHERE "userId" = $1 RETURNING` the old value, and write that returned value to the ledger. One statement leaves no gap to interleave into, and "revoke = zero it out" matches the business intent.

### H2. No Stripe idempotency keys on charge-creating calls; purchase endpoint has a read-then-act concurrency window

`src/stripe/adapter/stripe.adapter.ts:117-123, 169-177, 200-213`; `src/stripe/stripe.controller.ts:92-127`

**Why:** `subscriptions.create` and `paymentIntents.create` are called without Stripe's `idempotencyKey` request option. A network timeout after Stripe accepted the request, followed by a retry, creates a second subscription or a second charge. Separately, `purchaseSubscription`'s "already has a paid sub" check is a plain read before the Stripe call — two concurrent requests both pass and create two paid subscriptions.

**Impact:** Duplicate real-money charges. The sync service's cancel-the-old-one behavior eventually converges to one subscription, but both first invoices are already charged and nothing refunds the loser.

**Fix:** Pass `{ idempotencyKey }` (derived from a client request id, or `userId + pricingOptionId + short window`) as the second argument to the Stripe SDK calls. For the endpoint race, take a per-user advisory lock or a unique "purchase in flight" row before calling Stripe.

### H3. Missing unique constraints and indexes on the identity columns every webhook depends on

`prisma/schema.prisma:13, 75`

**Why:** `User.providerCustomerId` and `Subscription.providerSubscriptionId` are looked up with `findFirst` in essentially every webhook strategy, but neither is unique nor indexed.

**Impact:** Correctness: nothing prevents two users from holding the same `providerCustomerId` (e.g. a bug in re-provisioning), after which webhooks route money and credits to whichever row `findFirst` happens to return. Performance: every webhook does a sequential scan on `User` and `Subscription`.

**Fix:** `providerCustomerId String? @unique` and at minimum `@@index` on `providerSubscriptionId`, ideally `@unique` (the repoint logic assumes one local row per Stripe sub anyway). Add migrations with a pre-check for existing duplicates.

---

## Medium

### M1. Invoice period taken from `lines[0]` while the price is taken from the subscription line

`src/stripe/adapter/stripe.adapter.ts:457-458` vs `src/stripe/webhook/strategies/invoice-paid.strategy.ts:29-31`

`mapInvoice` sets `periodStart/periodEnd` from `lines.data[0]`, but consumers pick `lineToUse` preferring the subscription line. Upgrade/proration invoices are multi-line and line order is not guaranteed. **Impact:** wrong `currentPeriodStart/End`, wrong `nextCreditResetAt`, and a wrong `creditKey.subscriptionPeriod` — the period-based dedupe key stops matching the actual billing period. Also, if `period` is absent, `new Date(undefined * 1000).toISOString()` throws inside key construction. **Fix:** derive period from the same line used for the price, fall back to invoice-level `period_start/end`, and guard undefined.

### M2. Swallowed logic errors leave webhook events FAILED forever with no retry path

`src/stripe/webhook/stripe-webhook.service.ts:40-54`

Non-DB/external errors are marked FAILED and the endpoint returns 200, so Stripe never redelivers; no cron sweeps FAILED (or stuck-RECEIVED-after-crash) events — the stale-reclaim at line 102 only triggers if Stripe happens to deliver again. **Impact:** a transient bug (e.g. the 25P02 failures from C3) permanently drops an `invoice.paid` — customer charged, credits never granted, discoverable only by log-grepping. **Fix:** add a sweeper cron that re-runs FAILED/stale-RECEIVED events from the stored `payload`, and an alert (not just `logger.error`) on FAILED count.

### M3. Duplicate-claim reclaim is not compare-and-swap

`src/stripe/webhook/stripe-webhook.service.ts:100-122`

Two concurrent deliveries of a FAILED/stale event both read the row, both `update` unconditionally, both return `true` and run the strategy concurrently. Business-level keys absorb the money paths, but `SubscriptionEvent` rows (no unique constraint) duplicate, and the two runs can interleave inside non-CAS strategies (e.g. `handlePaymentFailureExpiration`'s status check is outside the transaction). **Fix:** `updateMany({ where: { id, status: existing.status }, ... })` and treat `count === 0` as "lost the race".

### M4. `customer.subscription.updated` → CANCELLED syncs status without revoking credits

`src/stripe/sync/subscription-sync.service.ts:90-100`, status map at `stripe.adapter.ts:42`

A non-payment-failure `canceled` update writes `status: CANCELLED` via the generic sync, but credit revocation and wallet deactivation only happen in the `customer.subscription.deleted` strategy. If the deleted event is dropped (see M2), the user keeps a CANCELLED plan with live credits and an active addon wallet.

### M5. Concurrent downgrade paths can create two free subscriptions on Stripe

`src/stripe/webhook/free-plan-downgrade.service.ts:49-58` + `src/stripe/stripe.service.ts:137-150`

The pointer guard is read-then-act, and `ensureFreeSubscription`'s "has active?" check races when `deleted` and `updated(unpaid)` for the same sub are processed concurrently — both list, both see none active, both create. Converges eventually via sync-cancel, but produces churn events and Stripe noise. **Fix:** take the pointer check inside the transaction as a CAS on `providerSubscriptionId`, and create the free sub only from the winner.

### M6. Missing FK indexes + unbounded reconciliation scan

`prisma/schema.prisma` (`Invoice.subscriptionId`, `Payment.userId`, `Payment.invoiceId`, `CreditTransaction.userId`), `src/cron/credit-reconciliation.cron.ts:17-31`

Postgres does not auto-index FK columns; `hasPriorPaidInvoice`, `getPayments`, and the reconciliation aggregates all scan. The reconciliation cron additionally loads *every* user and issues 4 queries per user, nightly, with no batching — at 100k users that's ~400k sequential queries at midnight alongside the credit-reset cron. **Fix:** add the indexes (`CreditTransaction @@index([userId, referenceType])` covers the aggregate) and batch reconciliation with a single grouped aggregate query.

### M7. `resetIntervalDay < 15` silently becomes monthly

`src/stripe/sync/paid-invoice-sync.service.ts:84`, `src/cron/credit-reset.cron.ts:54`

`Math.max(1, Math.round(resetIntervalDay / 30))` maps a 7-day plan to 1 month. The field's contract says days; the implementation only supports month multiples. **Fix:** validate `resetIntervalDay % 30 === 0` at plan creation, or implement day-based resets.

---

## Low

### L1. Reconciliation alarms are log-lines only
`credit-reconciliation.cron.ts:49-74` — `[ALARM]` via `logger.error` with no metric/alert hook means negative balances (H1) are detected but nobody is paged. Emit a metric or push to an alerting channel.

### L2. `recordSucceeded` rewrites `paidAt` on every replay
`src/stripe/payment.service.ts:61` — the upsert's update branch sets `paidAt: new Date()` again, drifting the recorded settlement time on redeliveries. Only set it in `create`.

### L3. Webhook controller converts all failures to 400
`stripe-webhook.controller.ts:53-58` — internal DB failures surface as `400 Bad Request`. Stripe retries any non-2xx so behavior is fine, but dashboards will misclassify outages as client errors. Return 500 for non-signature errors.

### L4. `handleDuplicateClaim` returns `true` when the row vanished
`stripe-webhook.service.ts:91-93` — processing proceeds without a claim row; the later `markProcessed` throws P2025 and the event lands in the catch path. Return `false` or re-create the claim.

### L5. Deploy-window note on `checkout.session.completed`
No strategy exists for it (the branch moved to off-session purchases; the Checkout DTOs were deleted). Any Checkout session still in flight when this deploys will complete as `UNHANDLED` — payment taken, no credits. If old clients could still have open Checkout sessions, keep a shim handler for one retention window.

---

## What's done well (keep)

- `claimAsPaid` CAS returning a boolean the caller can't ignore.
- Never-downgrade-SUCCEEDED invariant in `PaymentService`.
- Semantic (period/reset-anchored, not timestamp-anchored) credit keys.
- `isStale` guard in `PaidInvoiceSyncService` — C1's fix is largely applying the same discipline to `SubscriptionSyncService`.
- Derived revoke/grant key pair keeping the two ledger entries paired.
