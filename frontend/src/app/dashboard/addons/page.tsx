'use client';

import { useState, useEffect } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { PlusSquare, AlertCircle } from 'lucide-react';
import LoadingSpinner from '@/components/LoadingSpinner';
import api from '@/lib/api';
import { AlertTriangle } from 'lucide-react';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '');

export default function AddonStorePage() {
  const [addons, setAddons] = useState<any[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [error, setError] = useState('');

  const fetchData = async () => {
    setLoading(true);
    try {
      const [addonsRes, statusRes] = await Promise.all([
        api.get('/pricing/addons'),
        api.get('/users/me/dashboard')
      ]);
      setAddons(addonsRes.data.filter((a: any) => a.isActive));
      setStatus(statusRes.data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handlePurchase = async (addonPackageId: string) => {
    setPurchasing(addonPackageId);
    setError('');
    
    try {
      const res = await api.post('/stripe/checkout/addon', { addonPackageId });
      const { clientSecret, status: paymentStatus } = res.data.data;

      if (paymentStatus === 'requires_action') {
        const stripe = await stripePromise;
        if (!stripe) throw new Error('Stripe failed to load');

        const { error: stripeError } = await stripe.confirmCardPayment(clientSecret);
        if (stripeError) {
          setError(stripeError.message || 'Payment failed');
          return;
        }
      }
      
      alert('Addon purchased successfully!');
      fetchData(); // Refresh credits
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to purchase addon.');
      if (err.response?.status === 400 && err.response?.data?.message?.includes('payment method')) {
        setError('Please add a default payment method first.');
      }
    } finally {
      setPurchasing(null);
    }
  };

  if (loading) return <LoadingSpinner message="Loading store..." />;

  const isFreePlan = status?.subscription?.plan?.isFree;
  const formatPrice = (price: number) => new Intl.NumberFormat('vi-VN').format(price) + '₫';

  return (
    <div style={{ padding: '40px', maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ marginBottom: '40px' }}>
        <h1 className="h1" style={{ marginBottom: '8px' }}>Addon Credits</h1>
        <p className="body-text" style={{ color: 'var(--text-secondary)' }}>
          Need more credits this month? Addon credits never expire as long as you have an active paid subscription.
        </p>
      </div>

      {error && (
        <div style={{ padding: '16px', backgroundColor: 'rgba(239, 65, 70, 0.1)', color: 'var(--danger)', borderRadius: '8px', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertTriangle size={20} />
          {error}
        </div>
      )}

      {isFreePlan && (
        <div style={{ padding: '16px', backgroundColor: 'rgba(245, 166, 35, 0.1)', color: 'var(--warning)', borderRadius: '8px', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertTriangle size={20} />
          You need an active Pro subscription to purchase and use addon credits.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '24px' }}>
        {addons.map(addon => (
          <div key={addon.id} className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
            <h3 className="h2" style={{ marginBottom: '8px' }}>{addon.name}</h3>
            <div style={{ color: 'var(--accent)', fontWeight: 600, fontSize: '18px', marginBottom: '16px' }}>
              +{addon.credits} credits
            </div>
            <div style={{ fontSize: '32px', fontWeight: 700, margin: '8px 0 24px' }}>
              {formatPrice(addon.price)}
            </div>
            
            <button 
              className="btn btn-secondary" 
              style={{ width: '100%' }}
              onClick={() => handlePurchase(addon.id)}
              disabled={isFreePlan || purchasing !== null}
            >
              {purchasing === addon.id ? 'Processing...' : 'Buy Now'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
