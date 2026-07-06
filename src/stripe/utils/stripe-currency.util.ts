/**
 * Stripe zero-decimal currencies
 * https://docs.stripe.com/currencies#zero-decimal
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'
]);

/**
 * Converts Stripe's integer amount to the real decimal amount based on the currency.
 */
export function formatStripeAmountToDatabase(amount: number, currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase())) {
    return amount;
  }
  return amount / 100;
}

/**
 * Converts a real decimal amount to Stripe's integer format based on the currency.
 */
export function formatDatabaseAmountToStripe(amount: number, currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase())) {
    return Math.round(amount);
  }
  return Math.round(amount * 100);
}
