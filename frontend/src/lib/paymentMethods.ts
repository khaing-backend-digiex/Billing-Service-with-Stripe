import api from './api';

export type StoredPaymentMethod = {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
};

type CardExpiry = Pick<StoredPaymentMethod, 'isDefault' | 'expMonth' | 'expYear'>;

/**
 * Why a card can't be charged right now. `null` means the user is good to buy.
 * Mirrors PaymentMethodSyncService.getDefaultOrThrow on the backend.
 */
export type PaymentMethodIssue = 'missing' | 'no-default' | 'expired';

// Same rule as the backend: a card is dead once the month after expMonth starts.
export function isCardExpired(card: CardExpiry): boolean {
  if (!card.expMonth || !card.expYear) return false;
  return new Date(card.expYear, card.expMonth, 1) <= new Date();
}

export function paymentMethodIssue(cards: CardExpiry[]): PaymentMethodIssue | null {
  if (cards.length === 0) return 'missing';

  const def = cards.find((c) => c.isDefault);
  if (!def) return 'no-default';

  return isCardExpired(def) ? 'expired' : null;
}

export async function fetchPaymentMethods(): Promise<StoredPaymentMethod[]> {
  try {
    const res = await api.get('/payment-methods');
    return res.data.data || [];
  } catch {
    return [];
  }
}

/**
 * True when a failed purchase was rejected for a missing/expired card rather
 * than something else (unpaid invoice, plan conflict, ...).
 */
export function isPaymentMethodError(error: unknown): boolean {
  const err = error as { response?: { status?: number; data?: { message?: string } } };
  if (err?.response?.status !== 400) return false;

  const message = err.response?.data?.message?.toLowerCase() || '';
  return message.includes('payment method') || message.includes('card has expired');
}

/** Guards against an open redirect through the `returnTo` query param. */
export function safeReturnTo(value: string | null): string | null {
  if (!value) return null;
  return value.startsWith('/dashboard/') ? value : null;
}
