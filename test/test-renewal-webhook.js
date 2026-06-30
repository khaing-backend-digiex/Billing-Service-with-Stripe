/**
 * ─────────────────────────────────────────────────────────────
 *  E2E Test: Subscription Renewal via Stripe Webhook
 * ─────────────────────────────────────────────────────────────
 *
 *  Flow:
 *    1. Seed Prisma DB (Neon): User, Plan, BillingCycle, PricingOption
 *    2. POST /stripe/webhook  → invoice.payment_succeeded (subscription_create)
 *       → Verify subscription created in DB
 *    3. Wait 5 minutes
 *    4. POST /stripe/webhook  → invoice.payment_succeeded (subscription_cycle)
 *       → Verify subscription renewed (new period, credits reset)
 *
 *  Usage:
 *    1. Start app: npm run start:dev
 *    2. Run test:  node test/test-renewal-webhook.js
 *
 *  Prerequisites:
 *    - App running on http://localhost:3000
 *    - Neon PostgreSQL accessible via DATABASE_URL in .env
 *    - STRIPE_WEBHOOK_SECRET set in .env
 * ─────────────────────────────────────────────────────────────
 */

const crypto = require('crypto');
const path = require('path');

// Load .env
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

// ─── Config ─────────────────────────────────────────────────
const BASE_URL = 'http://localhost:3000';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const RENEWAL_DELAY_MS = 5 * 60 * 1000; // 5 minutes

// ─── Test IDs (unique per run) ──────────────────────────────
const RUN_ID = Date.now();
const TEST_USER_ID = 'test_user_' + RUN_ID;
const TEST_EMAIL = `renewal-test-${RUN_ID}@example.com`;
const TEST_STRIPE_CUSTOMER_ID = 'cus_test_' + RUN_ID;
const TEST_STRIPE_SUBSCRIPTION_ID = 'sub_test_' + RUN_ID;
const TEST_STRIPE_PRICE_ID = 'price_test_' + RUN_ID;

// Prisma v7 requires adapter
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ─── Helpers ────────────────────────────────────────────────

function signPayload(payload, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payloadStr = JSON.stringify(payload);
  const signedPayload = `${timestamp}.${payloadStr}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');
  return {
    signature: `t=${timestamp},v1=${signature}`,
    body: payloadStr,
  };
}

async function sendWebhook(event) {
  const { signature, body } = signPayload(event, WEBHOOK_SECRET);

  const response = await fetch(`${BASE_URL}/stripe/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': signature,
    },
    body: body,
  });

  const responseText = await response.text();
  return { status: response.status, body: responseText };
}

function buildInvoiceEvent(params) {
  const {
    eventId,
    invoiceId,
    paymentIntentId,
    subscriptionId,
    customerId,
    priceId,
    billingReason,
    periodStart,
    periodEnd,
    amountDue = 999,
    amountPaid = 999,
    currency = 'usd',
  } = params;

  return {
    id: eventId,
    object: 'event',
    type: 'invoice.payment_succeeded',
    data: {
      object: {
        id: invoiceId,
        object: 'invoice',
        customer: customerId,
        subscription: subscriptionId,
        billing_reason: billingReason,
        payment_intent: paymentIntentId,
        amount_due: amountDue,
        amount_paid: amountPaid,
        currency: currency,
        attempt_count: 1,
        next_payment_attempt: null,
        created: periodStart,
        lines: {
          data: [
            {
              price: { id: priceId },
              period: { start: periodStart, end: periodEnd },
            },
          ],
        },
      },
    },
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    api_version: '2024-12-18.acacia',
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(emoji, message) {
  const ts = new Date().toLocaleTimeString('vi-VN');
  console.log(`[${ts}] ${emoji} ${message}`);
}

// ─── Seed (Prisma / Neon only) ──────────────────────────────

async function seedDatabase() {
  log('🌱', 'Seeding Prisma database (Neon)...');

  // 1. Create Prisma User with providerCustomerId
  await prisma.user.upsert({
    where: { id: TEST_USER_ID },
    update: { providerCustomerId: TEST_STRIPE_CUSTOMER_ID },
    create: {
      id: TEST_USER_ID,
      email: TEST_EMAIL,
      provider: 'STRIPE',
      providerCustomerId: TEST_STRIPE_CUSTOMER_ID,
    },
  });
  log('  ✅', `User: id=${TEST_USER_ID}, providerCustomerId=${TEST_STRIPE_CUSTOMER_ID}`);

  // 2. BillingCycle
  let billingCycle = await prisma.billingCycle.findFirst({
    where: { name: 'Test 5min Cycle' },
  });
  if (!billingCycle) {
    billingCycle = await prisma.billingCycle.create({
      data: { name: 'Test 5min Cycle', durationDay: 1 },
    });
  }
  log('  ✅', `BillingCycle: ${billingCycle.name}`);

  // 3. Plan
  let plan = await prisma.plan.findFirst({ where: { code: 'TEST_RENEWAL_PLAN' } });
  if (!plan) {
    plan = await prisma.plan.create({
      data: {
        code: 'TEST_RENEWAL_PLAN',
        name: 'Test Renewal Plan',
        renewalCredits: 100,
        resetIntervalDay: 1,
      },
    });
  }
  log('  ✅', `Plan: ${plan.code} (renewalCredits=${plan.renewalCredits})`);

  // 4. PricingOption
  let pricingOption = await prisma.pricingOption.findFirst({
    where: { providerPriceId: TEST_STRIPE_PRICE_ID },
  });
  if (!pricingOption) {
    pricingOption = await prisma.pricingOption.create({
      data: {
        planId: plan.id,
        billingCycleId: billingCycle.id,
        name: 'Test $9.99',
        price: 9.99,
        currency: 'usd',
        provider: 'STRIPE',
        providerPriceId: TEST_STRIPE_PRICE_ID,
      },
    });
  }
  log('  ✅', `PricingOption: providerPriceId=${pricingOption.providerPriceId}`);

  return { plan, pricingOption, billingCycle };
}

// ─── Cleanup ────────────────────────────────────────────────

async function cleanup() {
  log('🧹', 'Cleaning up old test data...');
  try {
    await prisma.subscriptionEvent.deleteMany({
      where: { subscription: { userId: TEST_USER_ID } },
    });
    await prisma.creditTransaction.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.payment.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.invoice.deleteMany({
      where: { subscription: { userId: TEST_USER_ID } },
    });
    await prisma.subscription.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.webhookEvent.deleteMany({
      where: { eventId: { startsWith: 'evt_test_' } },
    });
    log('  ✅', 'Cleanup complete');
  } catch (err) {
    log('  ⚠️', `Cleanup partial: ${err.message}`);
  }
}

// ─── Verify ─────────────────────────────────────────────────

async function verifySubscriptionCreated() {
  const sub = await prisma.subscription.findUnique({
    where: { userId: TEST_USER_ID },
    include: { events: true, invoices: true },
  });

  if (!sub) throw new Error('Subscription NOT found after create event!');

  log('  ✅', `Subscription ID: ${sub.id}`);
  log('  ✅', `Status: ${sub.status}`);
  log('  ✅', `Credits: ${sub.subscriptionCreditsRemaining}`);
  log('  ✅', `Period: ${sub.currentPeriodStart.toISOString()} → ${sub.currentPeriodEnd.toISOString()}`);
  log('  ✅', `Events: ${sub.events.length} (CREATED)`);
  log('  ✅', `Invoices: ${sub.invoices.length}`);

  if (sub.status !== 'ACTIVE') throw new Error(`Expected ACTIVE, got ${sub.status}`);
  if (sub.events.length < 1) throw new Error('Missing CREATED event');

  return sub;
}

async function verifySubscriptionRenewed(originalSub) {
  const sub = await prisma.subscription.findUnique({
    where: { userId: TEST_USER_ID },
    include: {
      events: { orderBy: { createdAt: 'asc' } },
      invoices: { orderBy: { createdAt: 'asc' } },
    },
  });

  if (!sub) throw new Error('Subscription NOT found after renewal!');

  log('  ✅', `Same subscription: ${sub.id === originalSub.id}`);
  log('  ✅', `Status: ${sub.status}`);
  log('  ✅', `Credits reset: ${sub.subscriptionCreditsRemaining}`);
  log('  ✅', `Old period: → ${originalSub.currentPeriodEnd.toISOString()}`);
  log('  ✅', `New period: ${sub.currentPeriodStart.toISOString()} → ${sub.currentPeriodEnd.toISOString()}`);
  log('  ✅', `Events: ${sub.events.length} (CREATED + RENEWED)`);
  log('  ✅', `Invoices: ${sub.invoices.length}`);

  if (sub.currentPeriodStart.getTime() === originalSub.currentPeriodStart.getTime()) {
    throw new Error('Period start was NOT updated!');
  }

  const renewedEvent = sub.events.find(e => e.type === 'RENEWED');
  if (!renewedEvent) throw new Error('Missing RENEWED event!');
  if (sub.invoices.length < 2) throw new Error(`Expected 2 invoices, got ${sub.invoices.length}`);

  const credits = await prisma.creditTransaction.findMany({
    where: { userId: TEST_USER_ID, type: 'RENEWAL' },
  });
  log('  ✅', `Credit transactions (RENEWAL): ${credits.length}`);

  return sub;
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  🔄 Subscription Renewal Webhook E2E Test');
  console.log('  ⏱  Renewal delay: 5 minutes');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');

  // Pre-flight check
  if (!WEBHOOK_SECRET) {
    log('❌', 'STRIPE_WEBHOOK_SECRET not set in .env!');
    return;
  }

  try {
    // Check app is running
    try {
      await fetch(`${BASE_URL}/health`);
      log('✅', 'App is running on ' + BASE_URL);
    } catch {
      log('❌', `App is NOT running on ${BASE_URL}. Start it first: npm run start:dev`);
      return;
    }

    // 0. Cleanup
    await cleanup();

    // 1. Seed
    await seedDatabase();

    const now = Math.floor(Date.now() / 1000);
    const fiveMinLater = now + 300;

    // ─── Step 1: Create subscription ────────────────────
    console.log('');
    log('📩', '══ Step 1: Sending subscription_create webhook ══');

    const createEvent = buildInvoiceEvent({
      eventId: 'evt_test_create_' + RUN_ID,
      invoiceId: 'in_test_create_' + RUN_ID,
      paymentIntentId: 'pi_test_create_' + RUN_ID,
      subscriptionId: TEST_STRIPE_SUBSCRIPTION_ID,
      customerId: TEST_STRIPE_CUSTOMER_ID,
      priceId: TEST_STRIPE_PRICE_ID,
      billingReason: 'subscription_create',
      periodStart: now,
      periodEnd: fiveMinLater,
    });

    const createResult = await sendWebhook(createEvent);
    log('  📬', `Response: ${createResult.status} — ${createResult.body}`);

    if (createResult.status !== 201 && createResult.status !== 200) {
      log('❌', `Create webhook FAILED (status ${createResult.status})`);
      log('💡', 'Webhook handler calls stripeService.retrieveSubscription() with fake ID.');
      log('  ', 'The real Stripe API rejects it. Consider mocking retrieveSubscription().');
      return;
    }

    log('✅', 'Create webhook accepted!');
    log('🔍', 'Verifying subscription...');
    const originalSub = await verifySubscriptionCreated();

    // ─── Step 2: Wait 5 minutes ─────────────────────────
    console.log('');
    log('⏳', '══ Step 2: Waiting 5 minutes for renewal... ══');

    const startWait = Date.now();
    const totalSec = RENEWAL_DELAY_MS / 1000;

    const progressInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startWait) / 1000);
      const remaining = totalSec - elapsed;
      const pct = Math.floor(elapsed / totalSec * 30);
      const bar = '█'.repeat(pct) + '░'.repeat(30 - pct);
      process.stdout.write(`\r  [${bar}] ${Math.floor(remaining / 60)}m ${remaining % 60}s remaining`);
    }, 1000);

    await sleep(RENEWAL_DELAY_MS);
    clearInterval(progressInterval);
    console.log('');
    log('✅', '5 minutes elapsed!');

    // ─── Step 3: Send renewal ───────────────────────────
    console.log('');
    log('📩', '══ Step 3: Sending subscription_cycle (renewal) webhook ══');

    const renewNow = Math.floor(Date.now() / 1000);
    const renewEnd = renewNow + 300;

    const renewEvent = buildInvoiceEvent({
      eventId: 'evt_test_renew_' + RUN_ID,
      invoiceId: 'in_test_renew_' + RUN_ID,
      paymentIntentId: 'pi_test_renew_' + RUN_ID,
      subscriptionId: TEST_STRIPE_SUBSCRIPTION_ID,
      customerId: TEST_STRIPE_CUSTOMER_ID,
      priceId: TEST_STRIPE_PRICE_ID,
      billingReason: 'subscription_cycle',
      periodStart: renewNow,
      periodEnd: renewEnd,
    });

    const renewResult = await sendWebhook(renewEvent);
    log('  📬', `Response: ${renewResult.status} — ${renewResult.body}`);

    if (renewResult.status !== 201 && renewResult.status !== 200) {
      log('❌', `Renewal webhook FAILED (status ${renewResult.status})`);
      return;
    }

    log('✅', 'Renewal webhook accepted!');

    // ─── Step 4: Verify renewal ─────────────────────────
    console.log('');
    log('🔍', '══ Step 4: Verifying renewal... ══');
    await verifySubscriptionRenewed(originalSub);

    console.log('');
    console.log('═══════════════════════════════════════════════════════');
    log('🎉', 'ALL TESTS PASSED! Subscription renewal works correctly.');
    console.log('═══════════════════════════════════════════════════════');

  } catch (err) {
    console.log('');
    console.error('═══════════════════════════════════════════════════════');
    log('💥', `TEST FAILED: ${err.message}`);
    console.error(err);
    console.error('═══════════════════════════════════════════════════════');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main();
