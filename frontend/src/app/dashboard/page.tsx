'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { Zap, CreditCard, Calendar } from 'lucide-react';
import { format } from 'date-fns';
import LoadingSpinner from '@/components/LoadingSpinner';

type DashboardData = {
  status: any;
  payments: any[];
};

export default function DashboardOverview() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;

    const fetchData = async () => {
      try {
        const [statusRes, paymentsRes] = await Promise.all([
          api.get('/users/me/dashboard'),
          api.get('/stripe/payments')
        ]);
        
        const dashboardData = statusRes.data.data;

        if (!dashboardData.subscription) {
          timeoutId = setTimeout(fetchData, 500);
          return;
        }

        setData({
          status: dashboardData,
          payments: paymentsRes.data.data
        });
        setLoading(false);
      } catch (err) {
        console.error('Failed to fetch dashboard data', err);
        setLoading(false);
      }
    };
    
    fetchData();

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, []);

  if (loading) {
    return <LoadingSpinner message="Loading overview..." />;
  }

  const { status, payments } = data || {};
  const currentPlan = status?.subscription?.plan;
  const pricingOption = status?.subscription?.pricingOption;
  const credits = status?.credits;
  
  const formatPrice = (price: number, currency: string = 'VND') => {
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency }).format(price);
  };

  return (
    <div style={{ padding: '40px', maxWidth: '1200px', margin: '0 auto' }}>
      <h1 className="h1" style={{ marginBottom: '32px' }}>Overview</h1>
      
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '24px', marginBottom: '48px' }}>
        
        {/* Subscription Card */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
            <Calendar color="var(--accent)" />
            <h2 className="h3">Current Plan</h2>
          </div>
          {currentPlan ? (
            <>
              <div style={{ fontSize: '24px', fontWeight: 600, marginBottom: '8px' }}>
                {currentPlan.name}
              </div>
              <div style={{ color: 'var(--text-secondary)', marginBottom: '16px' }}>
                {pricingOption ? `${formatPrice(pricingOption.price, pricingOption.currency)} / ${pricingOption.billingCycle.name.toLowerCase()}` : 'Free'}
              </div>
              
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '24px' }}>
                <span style={{ 
                  padding: '4px 8px', 
                  backgroundColor: status.subscription.status === 'ACTIVE' ? 'rgba(16, 163, 127, 0.1)' : 'rgba(245, 166, 35, 0.1)', 
                  color: status.subscription.status === 'ACTIVE' ? 'var(--accent)' : 'var(--warning)',
                  borderRadius: '4px',
                  fontSize: '12px',
                  fontWeight: 500
                }}>
                  {status.subscription.status}
                </span>
                {status.subscription.nextCreditResetAt && (
                  <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                    Renews {format(new Date(status.subscription.nextCreditResetAt), 'MMM d, yyyy')}
                  </span>
                )}
              </div>
              
              <Link href="/dashboard/subscription" className="btn btn-secondary" style={{ width: '100%' }}>
                Manage Subscription
              </Link>
            </>
          ) : (
            <div style={{ color: 'var(--text-secondary)' }}>No active plan found.</div>
          )}
        </div>

        {/* Credits Card */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
            <Zap color="var(--accent)" />
            <h2 className="h3">Credits</h2>
          </div>
          <div style={{ fontSize: '32px', fontWeight: 700, marginBottom: '8px' }}>
            {credits?.balance || 0}
            <span style={{ fontSize: '16px', fontWeight: 400, color: 'var(--text-secondary)' }}>
              {' '}remaining
            </span>
          </div>
          
          <div style={{ backgroundColor: 'var(--bg-tertiary)', height: '8px', borderRadius: '4px', overflow: 'hidden', marginBottom: '16px' }}>
            <div style={{ 
              backgroundColor: 'var(--accent)', 
              height: '100%', 
              width: `${Math.min(100, ((credits?.balance || 0) / (currentPlan?.creditPolicy?.creditAmount || 1)) * 100)}%` 
            }} />
          </div>
          
          <div style={{ display: 'flex', gap: '12px' }}>
            <Link href="/dashboard/credits" className="btn btn-secondary" style={{ flex: 1 }}>
              View Details
            </Link>
            <Link href="/dashboard/addons" className="btn btn-secondary" style={{ flex: 1 }}>
              Buy More
            </Link>
          </div>
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <h2 className="h2">Recent Payments</h2>
          <Link href="/dashboard/payments" style={{ color: 'var(--accent)', fontSize: '14px', fontWeight: 500 }}>
            View All →
          </Link>
        </div>
        
        {payments && payments.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {payments.slice(0, 3).map((payment: any) => (
              <div key={payment.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '16px', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <div style={{ fontWeight: 500, marginBottom: '4px' }}>
                    {formatPrice(payment.amount, payment.currency)}
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                    {format(new Date(payment.createdAt), 'MMM d, yyyy h:mm a')}
                  </div>
                </div>
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '6px', 
                  color: payment.status === 'SUCCEEDED' ? 'var(--accent)' : payment.status === 'FAILED' ? 'var(--danger)' : 'var(--warning)',
                  fontSize: '13px',
                  fontWeight: 500
                }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: 'currentColor' }} />
                  {payment.status}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ color: 'var(--text-secondary)' }}>No payments found.</div>
        )}
      </div>
    </div>
  );
}
