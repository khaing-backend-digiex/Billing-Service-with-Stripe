'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { format } from 'date-fns';
import { Zap, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import LoadingSpinner from '@/components/LoadingSpinner';

export default function CreditsPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await api.get('/users/me/dashboard');
        setData(res.data.data);
      } catch (err) {
        console.error('Failed to load credits status', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  if (loading) return <LoadingSpinner message="Loading credits..." />;

  const { subscription, credits } = data || {};
  const isFrozen = subscription?.status === 'PAST_DUE' || subscription?.status === 'PAUSED';

  const getSourceTypeStyles = (sourceType: string) => {
    switch (sourceType) {
      case 'SUBSCRIPTION_ALLOCATION':
      case 'SUBSCRIPTION_RESET':
        return { bg: 'rgba(16, 163, 127, 0.1)', color: 'var(--accent)' };
      case 'ADDON':
        return { bg: 'rgba(91, 158, 244, 0.1)', color: 'var(--info)' };
      case 'GIFT':
        return { bg: 'rgba(192, 132, 252, 0.1)', color: '#C084FC' };
      case 'PROMOTION':
        return { bg: 'rgba(245, 166, 35, 0.1)', color: 'var(--warning)' };
      case 'ADMIN':
        return { bg: 'var(--bg-tertiary)', color: 'var(--text-secondary)' };
      default:
        return { bg: 'var(--bg-tertiary)', color: 'var(--text-primary)' };
    }
  };

  const getSourceLabel = (sourceType: string) => {
    switch (sourceType) {
      case 'SUBSCRIPTION_ALLOCATION': return 'Sub Setup';
      case 'SUBSCRIPTION_RESET': return 'Sub Reset';
      case 'ADDON': return 'Addon';
      case 'GIFT': return 'Gift';
      case 'PROMOTION': return 'Promo';
      case 'ADMIN': return 'Admin';
      default: return sourceType;
    }
  };

  return (
    <div style={{ padding: '40px', maxWidth: '800px', margin: '0 auto' }}>
      <h1 className="h1" style={{ marginBottom: '32px' }}>Credits</h1>

      {isFrozen && (
        <div style={{ padding: '16px', backgroundColor: 'rgba(239, 65, 70, 0.1)', color: 'var(--danger)', borderRadius: '8px', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertTriangle size={20} />
          Your credits are currently frozen due to a paused or past-due subscription. Please update your payment method or resume your subscription to use them.
        </div>
      )}

      <div className="card" style={{ marginBottom: '32px', opacity: isFrozen ? 0.6 : 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <Zap color="var(--accent)" />
          <h2 className="h2">Total Balance</h2>
        </div>
        
        <div style={{ fontSize: '48px', fontWeight: 700, marginBottom: '8px', color: isFrozen ? 'var(--danger)' : 'inherit' }}>
          {credits?.balance || 0}
        </div>
        
        <div style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>
          Next reset: {subscription?.nextCreditResetAt ? format(new Date(subscription.nextCreditResetAt), 'MMM d, yyyy') : 'N/A'}
          <div style={{ fontSize: '13px', marginTop: '4px' }}>Subscription credits are reset at the end of each billing cycle. Addon credits roll over.</div>
        </div>

        {isFrozen ? (
          <button className="btn btn-secondary" disabled>Buy More Credits</button>
        ) : (
          <Link href="/dashboard/addons" className="btn btn-secondary">
            Buy More Credits
          </Link>
        )}
      </div>

      <div className="card">
        <h2 className="h3" style={{ marginBottom: '24px' }}>Active Credit Grants</h2>
        
        {credits?.grants && credits.grants.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: '13px' }}>
                  <th style={{ padding: '12px 0', fontWeight: 500 }}>Source</th>
                  <th style={{ padding: '12px 0', fontWeight: 500 }}>Granted</th>
                  <th style={{ padding: '12px 0', fontWeight: 500 }}>Remaining</th>
                  <th style={{ padding: '12px 0', fontWeight: 500 }}>Expires</th>
                </tr>
              </thead>
              <tbody>
                {credits.grants.map((grant: any) => {
                  const style = getSourceTypeStyles(grant.sourceType);
                  return (
                    <tr key={grant.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '16px 0' }}>
                        <span style={{ 
                          padding: '4px 8px', 
                          backgroundColor: style.bg,
                          color: style.color,
                          borderRadius: '4px',
                          fontSize: '12px',
                          fontWeight: 500
                        }}>
                          {getSourceLabel(grant.sourceType)}
                        </span>
                      </td>
                      <td style={{ padding: '16px 0' }}>{grant.amountGranted}</td>
                      <td style={{ padding: '16px 0', fontWeight: 600 }}>{grant.amountRemaining}</td>
                      <td style={{ padding: '16px 0', color: 'var(--text-secondary)' }}>
                        {grant.expiresAt ? format(new Date(grant.expiresAt), 'MMM d, yyyy') : 'Never'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ color: 'var(--text-secondary)' }}>No active credit grants.</div>
        )}
      </div>
    </div>
  );
}
