'use client';

import { useState, useEffect } from 'react';
import { getStripe } from '@/lib/stripe';
import LoadingSpinner from '@/components/LoadingSpinner';
import api from '@/lib/api';
import { AlertTriangle, Zap } from 'lucide-react';
import { useToast } from '@/components/Toast';
import PaymentMethodRequiredModal from '@/components/PaymentMethodRequiredModal';
import {
  StoredPaymentMethod,
  PaymentMethodIssue,
  paymentMethodIssue,
  fetchPaymentMethods,
  isPaymentMethodError,
} from '@/lib/paymentMethods';

const stripePromise = getStripe();

export default function AddonStorePage() {
  const toast = useToast();
  const [addons, setAddons] = useState<any[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [cards, setCards] = useState<StoredPaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [confirmAddon, setConfirmAddon] = useState<any>(null);
  const [cardModal, setCardModal] = useState<{ issue: PaymentMethodIssue; itemLabel: string } | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [addonsRes, statusRes, cardsRes] = await Promise.all([
        api.get('/pricing/addons'),
        api.get('/users/me/dashboard'),
        api.get('/payment-methods')
      ]);
      setAddons(addonsRes.data.filter((a: any) => a.isActive));
      setStatus(statusRes.data.data);
      setCards(cardsRes.data.data || []);
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
      // The card may have been removed or expired since the page loaded – re-read
      // the list so the prompt matches the real reason.
      if (isPaymentMethodError(err)) {
        const list = await fetchPaymentMethods();
        setCards(list);
        setCardModal({
          issue: paymentMethodIssue(list) ?? 'missing',
          itemLabel: addons.find(a => a.id === addonPackageId)?.name || 'this addon',
        });
      } else {
        setError(err.response?.data?.message || err.message || 'Failed to purchase addon.');
      }
    } finally {
      setPurchasing(null);
    }
  };

  const startPurchase = (addon: any) => {
    const issue = paymentMethodIssue(cards);
    if (issue) {
      setCardModal({ issue, itemLabel: addon.name });
      return;
    }
    setConfirmAddon(addon);
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
          backgroundColor: 'var(--overlay)', zIndex: 1000,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'white'
        }}>
          <div style={{
            width: '40px', height: '40px', border: '3px solid rgba(255,255,255,0.3)',
            borderTopColor: 'white', borderRadius: '50%', animation: 'spin 1s linear infinite', marginBottom: '16px'
          }} />
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>Activating your credits...</h2>
          <p style={{ marginTop: '8px', opacity: 0.8 }}>Please do not close this window.</p>
        </div>
      )}

      <PaymentMethodRequiredModal
        open={cardModal !== null}
        onClose={() => setCardModal(null)}
        issue={cardModal?.issue ?? 'missing'}
        itemLabel={cardModal?.itemLabel}
        returnTo="/dashboard/addons"
      />

      {/* Purchase Confirmation Modal */}
      {confirmAddon && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'var(--overlay)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <div className="card" style={{ maxWidth: '440px', width: '100%', margin: '20px' }}>
            <h2 className="h2" style={{ marginBottom: '8px' }}>Confirm Purchase</h2>
            <p className="body-text" style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>
              Your default payment method will be charged immediately for this addon pack.
            </p>

            <div style={{ backgroundColor: 'var(--bg-primary)', padding: '16px', borderRadius: '8px', marginBottom: '24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <span>{confirmAddon.name}</span>
                <span style={{ color: 'var(--credit)', fontWeight: 500 }}>+{confirmAddon.credits} credits</span>
              </div>
              <div style={{ borderTop: '1px solid var(--border)', margin: '12px 0' }}></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600, fontSize: '16px' }}>
                <span>Total</span>
                <span>{formatPrice(confirmAddon.price, confirmAddon.currency)}</span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setConfirmAddon(null)} disabled={purchasing !== null}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={purchasing !== null}
                onClick={() => { const a = confirmAddon; setConfirmAddon(null); handlePurchase(a.id); }}
              >
                Confirm & Pay {formatPrice(confirmAddon.price, confirmAddon.currency)}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginBottom: '40px' }}>
        <h1 className="h1" style={{ marginBottom: '8px' }}>Addon Credits</h1>
        <p className="body-text" style={{ color: 'var(--text-secondary)' }}>
          Need more credits this month? Addon credits never expire as long as you have an active paid subscription.
        </p>
      </div>

      {error && (
        <div style={{ padding: '16px', backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: '8px', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertTriangle size={20} />
          {error}
        </div>
      )}

      {isPastDue && (
        <div style={{ padding: '16px', backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: '8px', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertTriangle size={20} />
          Your subscription is past due or paused. Credits are temporarily frozen and cannot be purchased or used.
        </div>
      )}

      {isFreePlan && !isPastDue && (
        <div style={{ padding: '16px', backgroundColor: 'var(--warning-bg)', color: 'var(--warning)', borderRadius: '8px', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertTriangle size={20} />
          You need an active Pro subscription to purchase and use addon credits.
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '24px', justifyContent: 'center' }}>
        {addons.map(addon => (
          <div key={addon.id} className="card card-interactive" style={{ flex: '1 1 280px', maxWidth: '320px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', opacity: isPastDue ? 0.6 : 1 }}>
            <h3 className="h2" style={{ marginBottom: '16px' }}>{addon.name}</h3>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '6px 14px', backgroundColor: 'var(--credit-bg)', color: 'var(--credit)',
              borderRadius: '999px', fontWeight: 600, fontSize: '15px', marginBottom: '20px'
            }}>
              <Zap size={16} fill="currentColor" /> +{addon.credits} credits
            </div>
            <div style={{ fontSize: '32px', fontWeight: 700, marginTop: 'auto', marginBottom: '24px' }}>
              {formatPrice(addon.price, addon.currency)}
            </div>

            <button
              className="btn btn-primary"
              style={{ width: '100%' }}
              onClick={() => startPurchase(addon)}
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
