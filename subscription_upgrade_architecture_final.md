# Subscription Upgrade Flow & Architecture

## Overview
This document outlines the architecture for handling Subscription Upgrades in our system. To comply with the Single Responsibility Principle and to handle Stripe's billing logic efficiently, the upgrade process is split into two distinct APIs.

This separation handles the fundamental difference in how Stripe calculates prorations and bills customers when changing a subscription tier (e.g., Pro to Ultra) versus changing a billing cycle (e.g., Monthly to Yearly).

---

## 1. Core Upgrade APIs

### API 1: Tier Upgrade (Same Cycle)
**Endpoint:** `POST /api/v1/subscriptions/{id}/upgrade-tier`
**Use Case:** Upgrading from a lower tier to a higher tier while keeping the same billing interval (e.g., Pro Monthly to Ultra Monthly).

**Billing Logic:**
* **Proration:** Default behavior. The system calculates the unused time on the old tier and the cost of the new tier.
* **Payment Timing:** The difference is added as a credit/debit to the next invoice. The user is not charged immediately at the moment of the upgrade.
* **Billing Cycle Anchor:** Remains unchanged.

**Stripe Parameter Setup (Java/Spring Boot example):**
```java
// Logic to be implemented in the Upgrade Service
SubscriptionUpdateParams params = SubscriptionUpdateParams.builder()
    .addItem(SubscriptionUpdateParams.Item.builder()
        .setId(existingSubscriptionItemId)
        .setPrice(newTierPriceId)
        .build())
    // We rely on Stripe's default proration behavior here.
    // Do NOT set billing_cycle_anchor or proration_behavior.
    .build();

Subscription.update(subscriptionId, params);
```

### API 2: Billing Cycle Upgrade (Monthly to Yearly)
**Endpoint:** `POST /api/v1/subscriptions/{id}/upgrade-cycle`
**Use Case:** Upgrading the billing interval from Monthly to Yearly (e.g., Pro Monthly to Pro Yearly or Ultra Yearly).

**Billing Logic:**
* **Proration:** The unused portion of the Monthly plan is credited against the new Yearly price.
* **Payment Timing:** The user is charged immediately for the difference.
* **Billing Cycle Anchor:** Reset to now. A new 1-year cycle starts exactly at the moment of the API call.

**Stripe Parameter Setup:**
```java
// Logic to be implemented in the Upgrade Service
SubscriptionUpdateParams params = SubscriptionUpdateParams.builder()
    .addItem(SubscriptionUpdateParams.Item.builder()
        .setId(existingSubscriptionItemId)
        .setPrice(yearlyPriceId)
        .build())
    // Force a new billing cycle starting today
    .setBillingCycleAnchor(SubscriptionUpdateParams.BillingCycleAnchor.NOW)
    // Force Stripe to generate an invoice and attempt payment immediately
    .setProrationBehavior(SubscriptionUpdateParams.ProrationBehavior.ALWAYS_INVOICE)
    .build();

Subscription.update(subscriptionId, params);
```

---

## 2. Preview Upgrade APIs (Upcoming Invoices)

To prevent "bill shock" and provide a transparent UX, the system provides preview endpoints. These APIs call Stripe's `Invoice.upcoming()` to simulate the upgrade without committing any changes to the database.

### API 3: Preview Tier Upgrade (Same Cycle)
**Endpoint:** `GET /api/v1/subscriptions/{id}/preview-upgrade-tier`
**Use Case:** Shows the user their projected next invoice when changing tiers, including deferred proration line items.

**Stripe Parameter Setup (Java/Spring Boot example):**
```java
public Invoice previewTierUpgrade(String customerId, String subscriptionId, String subscriptionItemId, String ultraPriceId) {
    InvoiceUpcomingParams params = InvoiceUpcomingParams.builder()
        .setCustomer(customerId)
        .setSubscription(subscriptionId)
        .setSubscriptionDetails(
            InvoiceUpcomingParams.SubscriptionDetails.builder()
                .addItem(
                    InvoiceUpcomingParams.SubscriptionDetails.Item.builder()
                        .setId(subscriptionItemId) // ID of current Pro plan
                        .setPrice(ultraPriceId)    // ID of new Ultra plan
                        .build()
                )
                // No overrides needed; uses default deferred logic
                .build()
        )
        .build();

    return Invoice.upcoming(params);
}
```

### API 4: Preview Billing Cycle Upgrade (Monthly to Yearly)
**Endpoint:** `GET /api/v1/subscriptions/{id}/preview-upgrade-cycle`
**Use Case:** Shows the exact amount the user must pay *today* to switch to a yearly cycle.

**Stripe Parameter Setup (Java/Spring Boot example):**
```java
public Invoice previewCycleUpgrade(String customerId, String subscriptionId, String subscriptionItemId, String yearlyPriceId) {
    InvoiceUpcomingParams params = InvoiceUpcomingParams.builder()
        .setCustomer(customerId)
        .setSubscription(subscriptionId)
        .setSubscriptionDetails(
            InvoiceUpcomingParams.SubscriptionDetails.builder()
                .addItem(
                    InvoiceUpcomingParams.SubscriptionDetails.Item.builder()
                        .setId(subscriptionItemId) // ID of current Monthly plan
                        .setPrice(yearlyPriceId)   // ID of new Yearly plan
                        .build()
                )
                // Must match the exact flags used in the actual upgrade
                .setBillingCycleAnchor(InvoiceUpcomingParams.SubscriptionDetails.BillingCycleAnchor.NOW)
                .setProrationBehavior(InvoiceUpcomingParams.SubscriptionDetails.ProrationBehavior.ALWAYS_INVOICE)
                .build()
        )
        .build();

    return Invoice.upcoming(params);
}
```

---

## 3. Webhook Integration & Revenue Leakage Handling

Since we are utilizing existing webhook handler files in this folder, they must be updated to securely handle asynchronous billing events, particularly for Tier Upgrades where payment is deferred to the next month.

**Event: `invoice.payment_failed`**
When a customer upgrades their tier but their card fails on the next billing cycle (due to insufficient funds or expired card), Stripe's Smart Retries (Dunning) will attempt to recover the funds.

**Required Updates to Existing Webhook Handler:**
* **Grace Period & Suspend/Downgrade:** If the webhook receives an `invoice.payment_failed` event and the invoice reaches the `uncollectible` state (or subscription becomes `past_due`), the backend must automatically downgrade the user's account to the Free tier.
* **Access Revocation:** Ensure the user instantly loses access to Pro/Ultra features.

**Event: `invoice.paid` / `charge.succeeded`**
* Update the local database `transactions` table with the `charge_id`, amount, and status for reconciliation.
* Extend the `current_period_end` in the `subscriptions` table.

---

## 4. Debt Recovery & Anti-Fraud Logic

Our system employs a "Freemium Debt Recovery" strategy to handle bad debt without permanently locking user accounts.

* **Card Removal Prevention (Built-in):** While on a paid plan (Pro/Ultra), Stripe prevents users from removing their default payment method unless a new one is provided.
* **Downgrade to Free:** Once downgraded to the Free tier (price = $0), users can freely remove their cards.
* **Customer Balance (The "Karma" Loop):** Any unpaid proration debt from a failed Tier Upgrade remains in the user's Stripe Customer Balance as a negative amount. If the user decides to upgrade to a paid plan again in the future, Stripe will automatically append this old debt to their new immediate invoice.
* **Accounting Write-offs:** For users who never return, the unpaid invoices will transition to void or uncollectible after the Dunning period, allowing the accounting system to write them off as bad debt (tax-exempt).

---

## 5. Action Plan for Refactoring

* **Controller Layer:** Split the current update endpoint into `/upgrade-tier` and `/upgrade-cycle`, and add two new `GET` endpoints (`/preview-upgrade-tier` and `/preview-upgrade-cycle`) for the UI.
* **Service Layer:** Create independent service methods for actual updates and previews using the isolated parameters shown above.
* **Webhook Layer (Modify existing files):**
    * Map the `invoice.payment_failed` event to the `UserService.downgradeToFree(userId)` method.
    * Ensure all successful cycle upgrade invoices are properly recorded in the database.
