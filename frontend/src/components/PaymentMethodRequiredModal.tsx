'use client';

import { useRouter } from 'next/navigation';
import { CreditCard } from 'lucide-react';
import Modal from './Modal';
import { PaymentMethodIssue } from '@/lib/paymentMethods';

type Copy = { title: string; body: string; cta: string };

const COPY: Record<PaymentMethodIssue, (item: string) => Copy> = {
  missing: (item) => ({
    title: 'No payment method',
    body: `You need a saved card before buying ${item}. Your card details are stored securely with Stripe.`,
    cta: 'Add a card',
  }),
  'no-default': (item) => ({
    title: 'No default payment method',
    body: `You have saved cards, but none of them is set as default. Pick one to continue with ${item}.`,
    cta: 'Choose default card',
  }),
  expired: (item) => ({
    title: 'Your card has expired',
    body: `Your default card has expired, so it can't be charged for ${item}. Add a new card to continue.`,
    cta: 'Add a new card',
  }),
};

type Props = {
  open: boolean;
  onClose: () => void;
  issue: PaymentMethodIssue;
  /** What the user was trying to buy, e.g. "Pro – yearly". */
  itemLabel?: string;
  /** Where to send the user back after the card is saved. */
  returnTo: string;
};

export default function PaymentMethodRequiredModal({
  open,
  onClose,
  issue,
  itemLabel,
  returnTo,
}: Props) {
  const router = useRouter();

  if (!open) return null;

  const { title, body, cta } = COPY[issue](itemLabel || 'this purchase');

  const goToPaymentMethods = () => {
    onClose();
    router.push(`/dashboard/payment-methods?returnTo=${encodeURIComponent(returnTo)}`);
  };

  return (
    <Modal isOpen={open} onClose={onClose} title={title} maxWidth="440px">
      <div style={{ display: 'flex', gap: '16px', marginBottom: '24px' }}>
        <div style={{
          flexShrink: 0, width: '40px', height: '40px', borderRadius: '8px',
          backgroundColor: 'var(--warning-bg)', color: 'var(--warning)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <CreditCard size={20} />
        </div>
        <p className="body-text" style={{ margin: 0, color: 'var(--text-secondary)' }}>{body}</p>
      </div>

      <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Not now</button>
        <button className="btn btn-primary" onClick={goToPaymentMethods}>{cta}</button>
      </div>
    </Modal>
  );
}
