'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { format } from 'date-fns';
import { History, ExternalLink, Download, Receipt } from 'lucide-react';
import LoadingSpinner from '@/components/LoadingSpinner';

export default function PaymentHistoryPage() {
  const [payments, setPayments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);

  useEffect(() => {
    const fetchPayments = async () => {
      try {
        const res = await api.get('/stripe/payments');
        setPayments(res.data.data);
      } catch (err) {
        console.error('Failed to load payments', err);
      } finally {
        setLoading(false);
      }
    };
    fetchPayments();
  }, []);

  const handleOpenPortal = async () => {
    setPortalLoading(true);
    try {
      const res = await api.post('/stripe/billing-portal');
      const { url } = res.data.data;
      if (url) {
        window.location.href = url;
      }
    } catch (err) {
      console.error('Failed to open billing portal', err);
      alert('Failed to open billing portal. Please try again.');
    } finally {
      setPortalLoading(false);
    }
  };

  const formatPrice = (price: number, currency: string = 'VND') => {
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency }).format(price);
  };

  return (
    <div style={{ padding: '40px', maxWidth: '800px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '32px' }}>
        <h1 className="h1">Payment History</h1>
        <button 
          onClick={handleOpenPortal} 
          disabled={portalLoading}
          className="btn btn-secondary"
          style={{ display: 'flex', gap: '8px' }}
        >
          {portalLoading ? 'Opening...' : 'Stripe Portal'} <ExternalLink size={16} />
        </button>
      </div>

      <div className="card">
        {loading ? (
          <LoadingSpinner message="Loading payments..." />
        ) : payments.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: '13px' }}>
                  <th style={{ padding: '12px 0', fontWeight: 500 }}>Date</th>
                  <th style={{ padding: '12px 0', fontWeight: 500 }}>Amount</th>
                  <th style={{ padding: '12px 0', fontWeight: 500 }}>Status</th>
                  <th style={{ padding: '12px 0', fontWeight: 500 }}>Description</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment: any) => (
                  <tr key={payment.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '16px 0' }}>
                      {format(new Date(payment.createdAt), 'MMM d, yyyy h:mm a')}
                    </td>
                    <td style={{ padding: '16px 0', fontWeight: 500 }}>
                      {formatPrice(payment.amount, payment.currency)}
                    </td>
                    <td style={{ padding: '16px 0' }}>
                      <span style={{ 
                        display: 'inline-flex', 
                        alignItems: 'center', 
                        gap: '6px', 
                        color: payment.status === 'SUCCEEDED' ? 'var(--accent)' : payment.status === 'FAILED' ? 'var(--danger)' : 'var(--warning)',
                        fontSize: '13px',
                        fontWeight: 500
                      }}>
                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: 'currentColor' }} />
                        {payment.status}
                      </span>
                    </td>
                    <td style={{ padding: '16px 0', color: 'var(--text-secondary)' }}>
                      {payment.addonPackageId ? 'Addon Credit Purchase' : 'Subscription Charge'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
            <Receipt size={48} style={{ margin: '0 auto 16px', opacity: 0.5 }} />
            <h3 className="h3" style={{ marginBottom: '8px', color: 'var(--text-primary)' }}>No payment history</h3>
            <p>You don't have any past payments yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
