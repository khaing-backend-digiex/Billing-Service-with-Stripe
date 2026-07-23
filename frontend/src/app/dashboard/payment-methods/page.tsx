'use client';

import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getStripe } from '@/lib/stripe';
import { Elements } from '@stripe/react-stripe-js';
import api from '@/lib/api';
import AddCardForm from '@/components/AddCardForm';
import { CreditCard, Star, Trash2 } from 'lucide-react';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useToast } from '@/components/Toast';
import {
  StoredPaymentMethod,
  fetchPaymentMethods,
  paymentMethodIssue,
  safeReturnTo,
} from '@/lib/paymentMethods';

const stripePromise = getStripe();

// The first card only becomes the default once Stripe's setup_intent.succeeded
// webhook lands, so wait for it before sending the user back to their purchase.
const SYNC_ATTEMPTS = 10;

export default function PaymentMethodsPage() {
  return (
    <Suspense fallback={<LoadingSpinner message="Loading payment methods..." />}>
      <PaymentMethodsContent />
    </Suspense>
  );
}

function PaymentMethodsContent() {
  const toast = useToast();
  const router = useRouter();
  const returnTo = safeReturnTo(useSearchParams().get('returnTo'));
  const [methods, setMethods] = useState<StoredPaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const fetchMethods = async () => {
    setLoading(true);
    try {
      const res = await api.get('/payment-methods');
      const list: StoredPaymentMethod[] = res.data.data || [];
      setMethods(list);
      return list;
    } catch (err) {
      console.error('Failed to load payment methods', err);
      return [];
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Coming back from a blocked purchase with no card at all: skip a click and
    // open the form. With cards already saved the user only needs a default.
    fetchMethods().then((list) => {
      if (returnTo && list.length === 0) setShowAddForm(true);
    });
  }, [returnTo]);

  const handleSetDefault = async (id: string) => {
    try {
      await api.post(`/payment-methods/${id}/default`);
      const list = await fetchMethods();

      if (returnTo && !paymentMethodIssue(list)) {
        toast.success('Default card updated. Taking you back to your purchase...');
        router.push(returnTo);
      }
    } catch (err) {
      console.error('Failed to set default', err);
      toast.error('Failed to set default payment method');
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this payment method?')) return;
    
    try {
      await api.delete(`/payment-methods/${id}`);
      fetchMethods();
    } catch (err) {
      console.error('Failed to delete', err);
      toast.error('Failed to delete payment method');
    }
  };

  const handleAddSuccess = async () => {
    setShowAddForm(false);

    if (!returnTo) {
      // Wait a moment for webhook to process and save the card
      setTimeout(() => {
        fetchMethods();
      }, 1500);
      return;
    }

    setSyncing(true);
    for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      const list = await fetchPaymentMethods();
      setMethods(list);

      if (!paymentMethodIssue(list)) {
        toast.success('Card saved. Taking you back to your purchase...');
        router.push(returnTo);
        return;
      }
    }

    setSyncing(false);
    toast.warning('Your card is still being confirmed. Please try your purchase again in a moment.');
  };

  return (
    <div style={{ padding: '40px', maxWidth: '800px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '32px' }}>
        <h1 className="h1">Payment Methods</h1>
        {!showAddForm && (
          <button className="btn btn-primary" onClick={() => setShowAddForm(true)} disabled={syncing}>
            + Add new card
          </button>
        )}
      </div>

      {returnTo && !loading && (
        <div style={{ padding: '16px', backgroundColor: 'var(--accent-bg)', color: 'var(--accent)', borderRadius: '8px', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <CreditCard size={20} />
          {methods.length > 0 && !methods.some((m) => m.isDefault)
            ? "Set one of your cards as default to continue your purchase. You'll be sent back right away."
            : "Add a card to continue your purchase. You'll be sent back as soon as it's saved."}
        </div>
      )}

      {showAddForm && (
        <div className="card animate-fade-in" style={{ marginBottom: '32px' }}>
          <Elements stripe={stripePromise}>
            <AddCardForm onSuccess={handleAddSuccess} onCancel={() => setShowAddForm(false)} />
          </Elements>
        </div>
      )}

      {syncing ? (
        <LoadingSpinner message="Confirming your card..." />
      ) : loading ? (
        <LoadingSpinner message="Loading payment methods..." />
      ) : methods.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {methods.map((method) => (
            <div key={method.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <div style={{ padding: '12px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                  <CreditCard size={24} color="var(--text-primary)" />
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '4px' }}>
                    <span style={{ fontWeight: 500, fontSize: '16px', textTransform: 'capitalize' }}>
                      {method.brand} •••• {method.last4}
                    </span>
                    {method.isDefault && (
                      <span style={{ 
                        display: 'inline-flex', 
                        alignItems: 'center', 
                        gap: '4px',
                        padding: '2px 8px', 
                        backgroundColor: 'var(--success-bg)',
                        color: 'var(--success)',
                        borderRadius: '12px',
                        fontSize: '12px',
                        fontWeight: 500
                      }}>
                        <Star size={12} fill="currentColor" /> Default
                      </span>
                    )}
                  </div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
                    Expires {method.expMonth.toString().padStart(2, '0')}/{method.expYear}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '12px' }}>
                {!method.isDefault && (
                  <button 
                    onClick={() => handleSetDefault(method.id)} 
                    className="btn btn-secondary"
                  >
                    Set Default
                  </button>
                )}
                <button 
                  onClick={() => handleDelete(method.id)}
                  className="btn btn-danger"
                  title="Delete"
                  style={{ padding: '8px' }}
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card" style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
          <CreditCard size={48} style={{ margin: '0 auto 16px', opacity: 0.5 }} />
          <h3 className="h3" style={{ marginBottom: '8px', color: 'var(--text-primary)' }}>No payment methods</h3>
          <p style={{ marginBottom: '24px' }}>Add a card to start subscribing to plans or purchasing addons.</p>
          {!showAddForm && (
            <button className="btn btn-primary" onClick={() => setShowAddForm(true)}>
              Add your first card
            </button>
          )}
        </div>
      )}
    </div>
  );
}
