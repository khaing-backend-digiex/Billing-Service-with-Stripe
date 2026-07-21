'use client';

import { useState, useEffect } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import api from '@/lib/api';
import { format } from 'date-fns';
import { Check, AlertCircle } from 'lucide-react';
import LoadingSpinner from '@/components/LoadingSpinner';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '');

export default function SubscriptionPage() {
  const [statusData, setStatusData] = useState<any>(null);
  const [plans, setPlans] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchData = async () => {
    setLoading(true);
    try {
      const [statusRes, plansRes] = await Promise.all([
        api.get('/users/me/dashboard'),
        api.get('/pricing/plans')
      ]);
      setStatusData(statusRes.data.data);
      setPlans(plansRes.data);
    } catch (err) {
      console.error(err);
      setError('Failed to load subscription details.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleUpgrade = async (pricingOptionId: string) => {
    setActionLoading(true);
    setError('');
    
    try {
      const res = await api.post('/stripe/checkout/subscription', { pricingOptionId });
      const { clientSecret, status } = res.data.data;

      if (status === 'requires_action') {
        const stripe = await stripePromise;
        if (!stripe) throw new Error('Stripe failed to load');

        const { error: stripeError } = await stripe.confirmCardPayment(clientSecret);
        if (stripeError) {
          setError(stripeError.message || 'Payment failed');
          return;
        }
      }
      
      // Success, refresh
      alert('Subscription upgraded successfully!');
      fetchData();
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to upgrade subscription.');
      if (err.response?.status === 400 && err.response?.data?.message?.includes('payment method')) {
        // Hint to user they might need a default payment method
        setError('Please add a default payment method first.');
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleCycleChange = async (pricingOptionId: string) => {
    setActionLoading(true);
    setError('');
    
    try {
      const previewRes = await api.get(`/payments/subscriptions/preview-upgrade-cycle?pricingOptionId=${pricingOptionId}`);
      const { amount_due, currency } = previewRes.data.data;
      
      if (window.confirm(`You will be charged ${new Intl.NumberFormat('vi-VN').format(amount_due)} ${currency.toUpperCase()} immediately to switch billing cycle. Continue?`)) {
        await api.post('/payments/subscriptions/upgrade-cycle', { pricingOptionId });
        alert('Billing cycle changed successfully!');
        fetchData();
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to change billing cycle.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!window.confirm('Are you sure you want to cancel your subscription? You will retain access until the end of your billing period.')) {
      return;
    }
    
    setActionLoading(true);
    try {
      await api.post('/payments/cancel-subscription', { reason: 'User requested' });
      alert('Subscription cancelled successfully.');
      fetchData();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to cancel subscription.');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) return <LoadingSpinner message="Loading subscription..." />;

  const currentSub = statusData?.subscription;
  const isFree = currentSub?.plan?.isFree;
  const currentPlanCode = currentSub?.plan?.code;
  const formatPrice = (price: number) => new Intl.NumberFormat('vi-VN').format(price) + '₫';

  return (
    <div style={{ padding: '40px', maxWidth: '800px', margin: '0 auto' }}>
      <h1 className="h1" style={{ marginBottom: '32px' }}>Manage Subscription</h1>

      {error && (
        <div style={{ padding: '16px', backgroundColor: 'rgba(239, 65, 70, 0.1)', color: 'var(--danger)', borderRadius: '8px', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertCircle size={20} />
          {error}
        </div>
      )}

      {/* Current Subscription Card */}
      <div className="card" style={{ marginBottom: '40px' }}>
        <h2 className="h2" style={{ marginBottom: '24px' }}>Current Plan</h2>
        
        {currentSub ? (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
              <div>
                <div style={{ fontSize: '24px', fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {currentSub.plan.name}
                  <span style={{ 
                    padding: '2px 8px', 
                    backgroundColor: currentSub.status === 'ACTIVE' ? 'rgba(16, 163, 127, 0.1)' : 'rgba(245, 166, 35, 0.1)', 
                    color: currentSub.status === 'ACTIVE' ? 'var(--accent)' : 'var(--warning)',
                    borderRadius: '4px',
                    fontSize: '12px',
                    fontWeight: 500,
                    textTransform: 'uppercase'
                  }}>
                    {currentSub.status}
                  </span>
                </div>
                {!isFree && (
                  <div style={{ color: 'var(--text-secondary)' }}>
                    {formatPrice(currentSub.pricingOption.price)} / {currentSub.pricingOption.billingCycle?.name?.toLowerCase()}
                  </div>
                )}
              </div>
              
              {!isFree && !currentSub.cancelledAt && (
                <button 
                  onClick={handleCancel}
                  disabled={actionLoading}
                  className="btn btn-danger"
                >
                  Cancel Plan
                </button>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', backgroundColor: 'var(--bg-primary)', padding: '16px', borderRadius: '8px', marginBottom: '24px' }}>
              <div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '4px' }}>Current Period</div>
                <div>
                  {format(new Date(currentSub.currentPeriodStart), 'MMM d, yyyy')} - {format(new Date(currentSub.currentPeriodEnd), 'MMM d, yyyy')}
                </div>
              </div>
              <div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '4px' }}>Next Reset</div>
                <div>{currentSub.nextCreditResetAt ? format(new Date(currentSub.nextCreditResetAt), 'MMM d, yyyy') : 'N/A'}</div>
              </div>
              <div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '4px' }}>Auto Renew</div>
                <div>{currentSub.autoRenew ? 'Yes' : 'No'}</div>
              </div>
              {currentSub.cancelledAt && (
                <div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '4px' }}>Cancelled At</div>
                  <div style={{ color: 'var(--warning)' }}>{format(new Date(currentSub.cancelledAt), 'MMM d, yyyy')}</div>
                </div>
              )}
            </div>

            {/* If paid plan, show cycle switch options */}
            {!isFree && currentSub.status === 'ACTIVE' && !currentSub.cancelledAt && (
              <div>
                <h3 className="h3" style={{ marginBottom: '16px' }}>Change Billing Cycle</h3>
                <div style={{ display: 'flex', gap: '16px' }}>
                  {plans.find(p => p.code === currentPlanCode)?.pricingOptions.map((opt: any) => {
                    const isCurrent = opt.id === currentSub.pricingOption.id;
                    return (
                      <div key={opt.id} style={{ 
                        flex: 1, 
                        border: `1px solid ${isCurrent ? 'var(--accent)' : 'var(--border)'}`, 
                        padding: '16px', 
                        borderRadius: '6px',
                        display: 'flex',
                        flexDirection: 'column'
                      }}>
                        <div style={{ fontWeight: 500, marginBottom: '8px' }}>{opt.billingCycle?.name}</div>
                        <div style={{ fontSize: '18px', marginBottom: '16px' }}>{formatPrice(opt.price)}</div>
                        {!isCurrent ? (
                          <button 
                            className="btn btn-secondary" 
                            style={{ width: '100%' }}
                            onClick={() => handleCycleChange(opt.id)}
                            disabled={actionLoading}
                          >
                            Switch to {opt.billingCycle?.name}
                          </button>
                        ) : (
                          <div style={{ color: 'var(--accent)', fontSize: '14px', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Check size={16} /> Current Cycle
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ color: 'var(--text-secondary)' }}>No active subscription.</div>
        )}
      </div>

      {/* Upgrade Options (if on Free plan) */}
      {isFree && (
        <div>
          <h2 className="h2" style={{ marginBottom: '24px' }}>Upgrade Plan</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {plans.filter(p => !p.isFree).map(plan => (
              <div key={plan.code} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h3 className="h3" style={{ marginBottom: '8px' }}>{plan.name}</h3>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', gap: '16px', color: 'var(--text-secondary)' }}>
                    <li>{plan.creditPolicy?.creditAmount} credits/mo</li>
                    <li>Priority support</li>
                  </ul>
                </div>
                <div style={{ display: 'flex', gap: '12px' }}>
                  {plan.pricingOptions.map((opt: any) => (
                    <button 
                      key={opt.id} 
                      onClick={() => handleUpgrade(opt.id)}
                      disabled={actionLoading}
                      className="btn btn-primary"
                    >
                      {opt.billingCycle?.name} ({formatPrice(opt.price)})
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
