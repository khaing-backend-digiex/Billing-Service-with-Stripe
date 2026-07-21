import Stripe from 'stripe';

export interface RecurringSpec {
  interval: 'day' | 'week' | 'month' | 'year';
  intervalCount: number;
}

export function stripeProductId(productCode: string, planCode: string): string {
  return `seed_${productCode}_${planCode}`.toLowerCase();
}

export function stripePriceLookupKey(
  productCode: string,
  planCode: string,
  cycleName: string,
  currency: string,
): string {
  return `seed_${productCode}_${planCode}_${cycleName}_${currency}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');
}

export async function adoptExistingPrice(
  stripe: Stripe,
  priceId: string,
  lookupKey: string,
): Promise<string | null> {
  let price: Stripe.Price;
  try {
    price = await stripe.prices.retrieve(priceId);
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') {
      return null;
    }
    throw error;
  }
  if (!price.active) return null;

  if (price.lookup_key !== lookupKey) {
    await stripe.prices.update(price.id, { lookup_key: lookupKey, transfer_lookup_key: true });
  }
  return price.id;
}

async function retrieveProduct(stripe: Stripe, id: string): Promise<Stripe.Product | null> {
  try {
    return await stripe.products.retrieve(id);
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') {
      return null;
    }
    throw error;
  }
}

export async function ensureStripeProduct(
  stripe: Stripe,
  id: string,
  name: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await retrieveProduct(stripe, id);
  if (!existing) {
    const created = await stripe.products.create({ id, name });
    return { id: created.id, created: true };
  }
  if (!existing.active) {
    await stripe.products.update(id, { active: true });
  }
  return { id: existing.id, created: false };
}

function priceMatches(
  price: Stripe.Price,
  params: { productId: string; unitAmount: number; currency: string; recurring: RecurringSpec },
): boolean {
  const productId = typeof price.product === 'string' ? price.product : price.product.id;
  return (
    productId === params.productId &&
    price.unit_amount === params.unitAmount &&
    price.currency === params.currency &&
    price.recurring?.interval === params.recurring.interval &&
    price.recurring?.interval_count === params.recurring.intervalCount
  );
}

export async function ensureStripeRecurringPrice(
  stripe: Stripe,
  params: {
    productId: string;
    lookupKey: string;
    unitAmount: number;
    currency: string;
    recurring: RecurringSpec;
  },
): Promise<{ id: string; created: boolean }> {
  const found = await stripe.prices.list({
    lookup_keys: [params.lookupKey],
    active: true,
    limit: 1,
  });
  const existing = found.data[0];
  if (existing && priceMatches(existing, params)) {
    return { id: existing.id, created: false };
  }

  const created = await stripe.prices.create({
    product: params.productId,
    unit_amount: params.unitAmount,
    currency: params.currency,
    recurring: {
      interval: params.recurring.interval,
      interval_count: params.recurring.intervalCount,
    },
    lookup_key: params.lookupKey,
    transfer_lookup_key: true,
  });
  return { id: created.id, created: true };
}
