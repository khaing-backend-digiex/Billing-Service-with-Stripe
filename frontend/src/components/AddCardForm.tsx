'use client';

import { useState } from 'react';
import { CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import api from '@/lib/api';

type AddCardFormProps = {
  onSuccess: () => void;
  onCancel: () => void;
};

export default function AddCardForm({ onSuccess, onCancel }: AddCardFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // 1. Create SetupIntent on the backend
      const res = await api.post('/payment-methods/setup-intent');
      const { clientSecret } = res.data.data;

      // 2. Confirm the setup intent with Stripe.js
      const cardElement = elements.getElement(CardElement);
      if (!cardElement) throw new Error('Card element not found');

      const { error: stripeError, setupIntent } = await stripe.confirmCardSetup(clientSecret, {
        payment_method: {
          card: cardElement,
        },
      });

      if (stripeError) {
        setError(stripeError.message || 'An error occurred during card setup.');
      } else if (setupIntent && setupIntent.status === 'succeeded') {
        // Success! Webhook will handle the rest on the backend, but we can optimistically call onSuccess
        onSuccess();
      }
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to setup payment method.');
    } finally {
      setLoading(false);
    }
  };

  const CARD_ELEMENT_OPTIONS = {
    style: {
      base: {
        // Stripe renders CardElement in an iframe that can't read CSS vars,
        // so these must be literal hex values matching the design tokens.
        color: '#F8FAFC', // var(--text-primary)
        fontFamily: 'Inter, sans-serif',
        fontSmoothing: 'antialiased',
        fontSize: '16px',
        '::placeholder': {
          color: '#64748B', // var(--text-muted)
        },
      },
      invalid: {
        color: '#EF4444', // var(--danger)
        iconColor: '#EF4444',
      },
    },
  };

  return (
    <form onSubmit={handleSubmit} style={{ width: '100%', maxWidth: '400px' }}>
      <div style={{ marginBottom: '24px' }}>
        <h3 className="h3" style={{ marginBottom: '8px' }}>Add a new card</h3>
        <p className="body-text" style={{ color: 'var(--text-secondary)' }}>Your card details are securely stored with Stripe.</p>
      </div>

      <div style={{ 
        padding: '12px', 
        backgroundColor: 'var(--bg-primary)', 
        border: '1px solid var(--border)', 
        borderRadius: '6px',
        marginBottom: '24px'
      }}>
        <CardElement options={CARD_ELEMENT_OPTIONS} />
      </div>

      {error && <div style={{ color: 'var(--danger)', marginBottom: '16px', fontSize: '14px', backgroundColor: 'var(--danger-bg)', padding: '12px', borderRadius: '6px' }}>{error}</div>}

      <div style={{ display: 'flex', gap: '12px' }}>
        <button type="submit" disabled={!stripe || loading} className="btn btn-primary" style={{ flex: 1 }}>
          {loading ? 'Saving...' : 'Save Card'}
        </button>
        <button type="button" onClick={onCancel} disabled={loading} className="btn btn-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}
