'use client';

import { useState, useEffect } from 'react';
import PublicNav from '@/components/PublicNav';
import api from '@/lib/api';
import { Check } from 'lucide-react';
import { loadStripe } from '@stripe/stripe-js';
import { useAuthStore } from '@/store/authStore';
import LoadingSpinner from '@/components/LoadingSpinner';
import Link from 'next/link';

type Plan = {
  code: string;
  name: string;
  isFree: boolean;
  creditPolicy: {
    creditAmount: number;
    resetInterval: string;
  };
  pricingOptions: {
    id: string;
    name: string;
    price: number;
    currency: string;
    billingCycle: {
      name: string;
      durationDay: number;
    };
  }[];
};

type Addon = {
  id: string;
  code: string;
  name: string;
  credits: number;
  price: number;
  currency: string;
  isActive: boolean;
};

export default function PricingPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [addons, setAddons] = useState<Addon[]>([]);
  const [loading, setLoading] = useState(true);
  const [billingCycle, setBillingCycle] = useState<'MONTHLY' | 'YEARLY'>('MONTHLY');
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  useEffect(() => {
    const fetchPricing = async () => {
      try {
        const [plansRes, addonsRes] = await Promise.all([
          api.get('/pricing/plans'),
          api.get('/pricing/addons'),
        ]);
        setPlans(plansRes.data);
        setAddons(addonsRes.data);
      } catch (err) {
        console.error('Failed to load pricing', err);
      } finally {
        setLoading(false);
      }
    };
    fetchPricing();
  }, []);

  const formatPrice = (price: number, currency: string = 'VND') => {
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency }).format(price);
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <PublicNav />
      
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '80px 20px' }}>
        <div style={{ textAlign: 'center', marginBottom: '60px' }}>
          <h1 className="h1" style={{ marginBottom: '16px' }}>Pricing</h1>
          <p className="body-text" style={{ color: 'var(--text-secondary)', fontSize: '18px' }}>
            Choose the plan that's right for you
          </p>
        </div>

        {/* Billing Cycle Toggle */}
        <div style={{ display: 'flex', backgroundColor: 'var(--bg-tertiary)', padding: '4px', borderRadius: '8px', marginBottom: '40px' }}>
          <button 
            className={`btn ${billingCycle === 'MONTHLY' ? 'btn-primary' : ''}`}
            onClick={() => setBillingCycle('MONTHLY')}
            style={{ backgroundColor: billingCycle === 'MONTHLY' ? 'var(--bg-secondary)' : 'transparent', color: billingCycle === 'MONTHLY' ? 'var(--text-primary)' : 'var(--text-secondary)', boxShadow: billingCycle === 'MONTHLY' ? '0 1px 3px rgba(0,0,0,0.2)' : 'none' }}
          >
            Monthly
          </button>
          <button 
            className={`btn ${billingCycle === 'YEARLY' ? 'btn-primary' : ''}`}
            onClick={() => setBillingCycle('YEARLY')}
            style={{ backgroundColor: billingCycle === 'YEARLY' ? 'var(--bg-secondary)' : 'transparent', color: billingCycle === 'YEARLY' ? 'var(--text-primary)' : 'var(--text-secondary)', boxShadow: billingCycle === 'YEARLY' ? '0 1px 3px rgba(0,0,0,0.2)' : 'none' }}
          >
            Yearly
          </button>
        </div>

        {loading ? (
          <LoadingSpinner fullPage message="Loading pricing plans..." />
        ) : (
          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', justifyContent: 'center', maxWidth: '1000px', width: '100%' }}>
            {plans.map((plan) => {
              // Find the right pricing option based on selected cycle (fallback to first if not found)
              const cycleStr = billingCycle === 'MONTHLY' ? 'MONTHLY' : 'ANUALLY'; // DB uses ANUALLY based on seed.ts
              const option = plan.pricingOptions?.find(o => o.billingCycle?.name === cycleStr) || plan.pricingOptions?.[0];
              
              if (!option && !plan.isFree) return null;

              return (
                <div key={plan.code} className="card card-interactive" style={{ flex: '1 1 300px', maxWidth: '380px', display: 'flex', flexDirection: 'column' }}>
                  <h2 className="h2" style={{ marginBottom: '8px' }}>
                    {plan.name}
                    {!plan.isFree && <span style={{ color: 'var(--accent)', marginLeft: '8px' }}>✦</span>}
                  </h2>
                  <div style={{ fontSize: '32px', fontWeight: 700, margin: '24px 0 8px' }}>
                    {plan.isFree ? '0₫' : formatPrice(option?.price || 0, option?.currency)}
                    <span style={{ fontSize: '16px', fontWeight: 400, color: 'var(--text-secondary)' }}>
                      /{billingCycle.toLowerCase()}
                    </span>
                  </div>
                  <div style={{ height: '1px', backgroundColor: 'var(--border)', margin: '24px 0' }} />
                  
                  <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 32px', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <li style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <Check size={18} color="var(--accent)" />
                      <span>{plan.creditPolicy?.creditAmount} credits / month</span>
                    </li>
                    <li style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <Check size={18} color="var(--accent)" />
                      <span>{plan.isFree ? 'Basic AI features' : 'Full AI access'}</span>
                    </li>
                    {!plan.isFree && (
                      <li style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <Check size={18} color="var(--accent)" />
                        <span>Priority support</span>
                      </li>
                    )}
                  </ul>

                  <Link 
                    href={isAuthenticated ? "/dashboard/subscription" : "/register"} 
                    className={`btn ${plan.isFree ? 'btn-secondary' : 'btn-primary'}`}
                    style={{ width: '100%', padding: '12px' }}
                  >
                    {plan.isFree ? 'Get Started' : 'Upgrade to Pro'}
                  </Link>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ marginTop: '80px', width: '100%', maxWidth: '1000px' }}>
          <h2 className="h2" style={{ textAlign: 'center', marginBottom: '40px' }}>Addon Credits</h2>
          {loading ? (
            <LoadingSpinner message="Loading addons..." />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '24px' }}>
              {addons.filter(a => a.isActive).map(addon => (
                <div key={addon.id} className="card card-interactive" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
                  <h3 className="h3" style={{ marginBottom: '8px' }}>{addon.name}</h3>
                  <div style={{ color: 'var(--text-secondary)', marginBottom: '16px' }}>{addon.credits} credits</div>
                  <div style={{ fontSize: '24px', fontWeight: 600, marginBottom: '24px' }}>
                    {formatPrice(addon.price, addon.currency)}
                  </div>
                  <Link 
                    href={isAuthenticated ? "/dashboard/addons" : "/register"}
                    className="btn btn-secondary" 
                    style={{ width: '100%' }}
                  >
                    Buy Now
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      <footer style={{ borderTop: '1px solid var(--border)', padding: '40px 20px', textAlign: 'center', color: 'var(--text-secondary)' }}>
        <p>© 2026 DigiCredit. All rights reserved.</p>
      </footer>
    </div>
  );
}
