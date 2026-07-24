const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'
]);

const MINOR_UNITS_PER_MAJOR = 100;

export function formatStripeAmountToDatabase(amount: number, currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase())) {
    return amount;
  }
  return amount / MINOR_UNITS_PER_MAJOR;
}

export function formatDatabaseAmountToStripe(amount: number, currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase())) {
    return Math.round(amount);
  }
  return Math.round(amount * MINOR_UNITS_PER_MAJOR);
}
