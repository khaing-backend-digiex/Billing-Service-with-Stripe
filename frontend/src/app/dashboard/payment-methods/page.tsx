'use client';

import { useState, useEffect } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import api from '@/lib/api';
import AddCardForm from '@/components/AddCardForm';
import { CreditCard, Star, Trash2 } from 'lucide-react';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '');

type PaymentMethod = {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
};

export default function PaymentMethodsPage() {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);

  const fetchMethods = async () => {
    setLoading(true);
    try {
      const res = await api.get('/payment-methods');
      setMethods(res.data.data || []);
    } catch (err) {
      console.error('Failed to load payment methods', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMethods();
  }, []);

  const handleSetDefault = async (id: string) => {
    try {
      await api.post(`/payment-methods/${id}/default`);
      fetchMethods();
    } catch (err) {
      console.error('Failed to set default', err);
      alert('Failed to set default payment method');
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this payment method?')) return;
    
    try {
      await api.delete(`/payment-methods/${id}`);
      fetchMethods();
    } catch (err) {
      console.error('Failed to delete', err);
      alert('Failed to delete payment method');
    }
  };

  const handleAddSuccess = () => {
    setShowAddForm(false);
    // Wait a moment for webhook to process and save the card
    setTimeout(() => {
      fetchMethods();
    }, 1500);
  };

  return (
    <div style={{ padding: '40px', maxWidth: '800px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '32px' }}>
        <h1 className="h1">Payment Methods</h1>
        {!showAddForm && (
          <button className="btn btn-primary" onClick={() => setShowAddForm(true)}>
            + Add new card
          </button>
        )}
      </div>

      {showAddForm && (
        <div className="card animate-fade-in" style={{ marginBottom: '32px' }}>
          <Elements stripe={stripePromise}>
            <AddCardForm onSuccess={handleAddSuccess} onCancel={() => setShowAddForm(false)} />
          </Elements>
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--text-secondary)' }}>Loading payment methods...</div>
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
                        backgroundColor: 'rgba(16, 163, 127, 0.1)', 
                        color: 'var(--accent)',
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
