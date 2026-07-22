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
  const [activating, setActivating] = useState(false);
  
  const [cancelModal, setCancelModal] = useState(false);
  const [cyclePreview, setCyclePreview] = useState<any>(null);
  const [cycleModal, setCycleModal] = useState<string | null>(null);

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
      const oldPricingOptionId = statusData?.subscription?.pricingOption?.id;
      const res = await api.post('/stripe/checkout/subscription', { pricingOptionId });
      const { clientSecret, status } = res.data.data;

      if (status === 'requires_action') {
        const stripe = await stripePromise;
        if (!stripe) throw new Error('Stripe failed to load');

        const { error: stripeError } = await stripe.confirmCardPayment(clientSecret);
        if (stripeError) {
          setError(stripeError.message || 'Payment failed');
          setActionLoading(false);
          return;
        }
      } else if (status === 'requires_payment_method') {
        setError('Payment failed. Please try a different payment method.');
        setActionLoading(false);
        return;
      }
      
      setActivating(true);
      let retries = 0;
      let success = false;
      while (retries < 15) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const checkRes = await api.get('/users/me/dashboard');
          const newPricingOptionId = checkRes.data.data.subscription?.pricingOption?.id;
          if (newPricingOptionId && newPricingOptionId !== oldPricingOptionId) {
            success = true;
            break;
          }
        } catch (e) {}
        retries++;
      }

      if (success) {
        alert('Subscription upgraded successfully!');
        fetchData();
      } else {
        setError('Payment succeeded but subscription update is delayed. Please refresh the page in a few minutes.');
      }
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to upgrade subscription.');
      if (err.response?.status === 400 && err.response?.data?.message?.includes('payment method')) {
        // Hint to user they might need a default payment method
        setError('Please add a default payment method first.');
      }
    } finally {
      setActionLoading(false);
      setActivating(false);
    }
  };

  const openCycleChangeModal = async (pricingOptionId: string) => {
    setActionLoading(true);
    setError('');
    
    try {
      const previewRes = await api.get(`/payments/subscriptions/preview-upgrade-cycle?pricingOptionId=${pricingOptionId}`);
      setCyclePreview(previewRes.data.data);
      setCycleModal(pricingOptionId);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to generate preview.');
    } finally {
      setActionLoading(false);
    }
  };

  const confirmCycleChange = async () => {
    if (!cycleModal) return;
    setActionLoading(true);
    try {
      await api.post('/payments/subscriptions/upgrade-cycle', { pricingOptionId: cycleModal });
      alert('Billing cycle changed successfully!');
      setCycleModal(null);
      setCyclePreview(null);
      fetchData();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to change billing cycle.');
    } finally {
      setActionLoading(false);
    }
  };

  const confirmCancel = async (immediate: boolean) => {
    setActionLoading(true);
    try {
      await api.post('/payments/cancel-subscription', { reason: 'User requested', immediate });
      alert(immediate ? 'Subscription cancelled immediately.' : 'Subscription will be cancelled at period end.');
      setCancelModal(false);
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
  const formatPrice = (price: number, currency: string = 'VND') => {
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency }).format(price);
  };

  return (
    <div style={{ padding: '40px', maxWidth: '800px', margin: '0 auto', position: 'relative' }}>
      {activating && (
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
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>Activating your subscription...</h2>
          <p style={{ marginTop: '8px', opacity: 0.8 }}>Please do not close this window.</p>
        </div>
      )}

      {/* Cancel Modal */}
      {cancelModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <div className="card" style={{ maxWidth: '500px', width: '100%', margin: '20px' }}>
            <h2 className="h2" style={{ marginBottom: '16px' }}>Cancel Subscription</h2>
            <p className="body-text" style={{ marginBottom: '24px' }}>How would you like to cancel your subscription?</p>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '24px' }}>
              <button className="btn btn-secondary" onClick={() => confirmCancel(false)} disabled={actionLoading} style={{ textAlign: 'left', display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontWeight: 600 }}>Cancel at end of billing period</span>
                <span style={{ fontSize: '13px', opacity: 0.8, fontWeight: 400 }}>You will retain access until {format(new Date(currentSub?.currentPeriodEnd || Date.now()), 'MMM d, yyyy')}.</span>
              </button>
              
              <button className="btn btn-danger" onClick={() => confirmCancel(true)} disabled={actionLoading} style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', backgroundColor: 'rgba(239, 65, 70, 0.1)', color: 'var(--danger)', border: '1px solid var(--danger)' }}>
                <span style={{ fontWeight: 600 }}>Cancel immediately</span>
                <span style={{ fontSize: '13px', opacity: 0.8, fontWeight: 400 }}>You will lose access immediately. No refund will be issued.</span>
              </button>
            </div>
            
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setCancelModal(false)} disabled={actionLoading}>Nevermind</button>
            </div>
          </div>
        </div>
      )}

      {/* Cycle Change Modal */}
      {cycleModal && cyclePreview && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <div className="card" style={{ maxWidth: '500px', width: '100%', margin: '20px' }}>
            <h2 className="h2" style={{ marginBottom: '16px' }}>Confirm Cycle Change</h2>
            
            <div style={{ marginBottom: '24px', backgroundColor: 'var(--bg-primary)', padding: '16px', borderRadius: '8px' }}>
              <h4 style={{ fontSize: '14px', marginBottom: '12px', color: 'var(--text-secondary)' }}>Invoice Breakdown</h4>
              {cyclePreview.lines.map((line: any) => (
                <div key={line.id} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '14px' }}>
                  <span>{line.description}</span>
                  <span>{formatPrice(line.amount, cyclePreview.currency)}</span>
                </div>
              ))}
              <div style={{ borderTop: '1px solid var(--border)', margin: '12px 0' }}></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600, fontSize: '16px' }}>
                <span>Amount Due Now</span>
                <span>{formatPrice(cyclePreview.amount_due, cyclePreview.currency)}</span>
              </div>
            </div>
            
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => { setCycleModal(null); setCyclePreview(null); }} disabled={actionLoading}>Cancel</button>
              <button className="btn btn-primary" onClick={confirmCycleChange} disabled={actionLoading}>
                Confirm and Pay {formatPrice(cyclePreview.amount_due, cyclePreview.currency)}
              </button>
            </div>
          </div>
        </div>
      )}

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
                    backgroundColor: currentSub.cancelledAt ? 'rgba(239, 65, 70, 0.1)' : (currentSub.status === 'ACTIVE' ? 'rgba(16, 163, 127, 0.1)' : 'rgba(245, 166, 35, 0.1)'), 
                    color: currentSub.cancelledAt ? 'var(--danger)' : (currentSub.status === 'ACTIVE' ? 'var(--accent)' : 'var(--warning)'),
                    borderRadius: '4px',
                    fontSize: '12px',
                    fontWeight: 500,
                    textTransform: 'uppercase'
                  }}>
                    {currentSub.cancelledAt ? 'CANCELS AT END OF PERIOD' : currentSub.status}
                  </span>
                </div>
                {!isFree && (
                  <div style={{ color: 'var(--text-secondary)' }}>
                    {formatPrice(currentSub.pricingOption.price, currentSub.pricingOption.currency)} / {currentSub.pricingOption.billingCycle?.name?.toLowerCase()}
                    {currentSub.cancelledAt && (
                      <div style={{ marginTop: '4px', color: 'var(--danger)', fontSize: '13px' }}>
                        Active until {format(new Date(currentSub.currentPeriodEnd), 'MMM d, yyyy')}
                      </div>
                    )}
                  </div>
                )}
              </div>
              
              {!isFree && !currentSub.cancelledAt && (
                <button 
                  onClick={() => setCancelModal(true)}
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
                        <div style={{ fontSize: '18px', marginBottom: '16px' }}>{formatPrice(opt.price, opt.currency)}</div>
                        {!isCurrent ? (
                          <button 
                            className="btn btn-secondary" 
                            style={{ width: '100%' }}
                            onClick={() => openCycleChangeModal(opt.id)}
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
                      {opt.billingCycle?.name} ({formatPrice(opt.price, opt.currency)})
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
