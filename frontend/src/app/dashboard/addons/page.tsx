'use client';

import { useState, useEffect } from 'react';
import { getStripe } from '@/lib/stripe';
import LoadingSpinner from '@/components/LoadingSpinner';
import api from '@/lib/api';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'react-hot-toast';

const stripePromise = getStripe();

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
      const oldBalance = status?.credits?.balance || 0;
      const res = await api.post('/stripe/checkout/addon', { addonPackageId });
      const { clientSecret, status: paymentStatus } = res.data.data;

      if (paymentStatus === 'requires_action') {
        const stripe = await stripePromise;
        if (!stripe) throw new Error('Stripe failed to load');

        const { error: stripeError } = await stripe.confirmCardPayment(clientSecret);
        if (stripeError) {
          setError(stripeError.message || 'Payment failed');
          setPurchasing(null);
          return;
        }
      } else if (paymentStatus === 'requires_payment_method') {
        setError('Payment failed. Please try a different payment method.');
        setPurchasing(null);
        return;
      }
      
      // Polling for webhook processing
      let retries = 0;
      let success = false;
      while (retries < 15) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const checkRes = await api.get('/users/me/dashboard');
          const newBalance = checkRes.data.data.credits?.balance || 0;
          if (newBalance > oldBalance) {
            success = true;
            break;
          }
        } catch (e) {}
        retries++;
      }

      if (success) {
        toast.success('Addon purchased and credits added successfully!');
        fetchData();
      } else {
        setError('Payment succeeded but credits are delayed. Please refresh the page in a few minutes.');
      }
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
  const isPastDue = status?.subscription?.status === 'PAST_DUE' || status?.subscription?.status === 'PAUSED';
  
  const formatPrice = (price: number, currency: string = 'VND') => {
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency }).format(price);
  };

  return (
    <div style={{ padding: '40px', maxWidth: '1000px', margin: '0 auto', position: 'relative' }}>
      {purchasing && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 1000,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'white'
        }}>
          <div style={{
            width: '40px', height: '40px', border: '3px solid rgba(255,255,255,0.3)',
            borderTopColor: 'white', borderRadius: '50%', animation: 'spin 1s linear infinite', marginBottom: '16px'
          }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>Activating your credits...</h2>
          <p style={{ marginTop: '8px', opacity: 0.8 }}>Please do not close this window.</p>
        </div>
      )}

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

      {isPastDue && (
        <div style={{ padding: '16px', backgroundColor: 'rgba(239, 65, 70, 0.1)', color: 'var(--danger)', borderRadius: '8px', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertTriangle size={20} />
          Your subscription is past due or paused. Credits are temporarily frozen and cannot be purchased or used.
        </div>
      )}

      {isFreePlan && !isPastDue && (
        <div style={{ padding: '16px', backgroundColor: 'rgba(245, 166, 35, 0.1)', color: 'var(--warning)', borderRadius: '8px', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertTriangle size={20} />
          You need an active Pro subscription to purchase and use addon credits.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '24px' }}>
        {addons.map(addon => (
          <div key={addon.id} className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', opacity: isPastDue ? 0.6 : 1 }}>
            <h3 className="h2" style={{ marginBottom: '8px' }}>{addon.name}</h3>
            <div style={{ color: 'var(--accent)', fontWeight: 600, fontSize: '18px', marginBottom: '16px' }}>
              +{addon.credits} credits
            </div>
            <div style={{ fontSize: '32px', fontWeight: 700, margin: '8px 0 24px' }}>
              {formatPrice(addon.price, addon.currency)}
            </div>
            
            <button 
              className="btn btn-secondary" 
              style={{ width: '100%' }}
              onClick={() => handlePurchase(addon.id)}
              disabled={isFreePlan || isPastDue || purchasing !== null}
            >
              Buy Now
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
