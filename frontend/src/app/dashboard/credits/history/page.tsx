'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { format } from 'date-fns';
import { AlertCircle, ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import LoadingSpinner from '@/components/LoadingSpinner';

export default function TransactionHistoryPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const limit = 10;

  const fetchHistory = async (pageNumber: number) => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get(`/credits/transactions?page=${pageNumber}&limit=${limit}`);
      setData(res.data.data);
    } catch (err: any) {
      console.error('Failed to load transaction history', err);
      setError(err.response?.data?.message || 'Failed to load transaction history.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory(page);
  }, [page]);

  const getTransactionTypeLabel = (type: string) => {
    switch (type) {
      case 'GRANT': return 'Credit Grant';
      case 'USAGE': return 'Consumption';
      case 'RENEWAL': return 'Subscription Renewal';
      case 'EXPIRATION': return 'Expired';
      case 'ADJUSTMENT': return 'Manual Adjustment';
      case 'ADDON_PURCHASE': return 'Addon Purchase';
      default: return type;
    }
  };

  const getAmountColor = (type: string, amount: number) => {
    if (type === 'USAGE' || type === 'EXPIRATION' || amount < 0) {
      return 'var(--danger)';
    }
    return 'var(--accent)';
  };

  const formatAmount = (type: string, amount: number) => {
    if (type === 'USAGE' || type === 'EXPIRATION' || amount < 0) {
      return `-${Math.abs(amount)}`;
    }
    return `+${Math.abs(amount)}`;
  };

  if (loading && !data) return <LoadingSpinner message="Loading history..." />;

  return (
    <div style={{ padding: '40px', maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ marginBottom: '32px', display: 'flex', alignItems: 'center', gap: '16px' }}>
        <Link href="/dashboard/credits" className="btn btn-secondary" style={{ padding: '8px' }}>
          <ArrowLeft size={20} />
        </Link>
        <h1 className="h1" style={{ margin: 0 }}>Transaction History</h1>
      </div>

      {error && (
        <div style={{ padding: '16px', backgroundColor: 'rgba(239, 65, 70, 0.1)', color: 'var(--danger)', borderRadius: '8px', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertCircle size={20} />
          {error}
        </div>
      )}

      <div className="card">
        {loading && data && (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 10 }}>
            <div style={{ width: '30px', height: '30px', border: '3px solid var(--accent)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
          </div>
        )}
        
        {data?.data && data.data.length > 0 ? (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    <th style={{ padding: '16px 8px', fontWeight: 500 }}>Date</th>
                    <th style={{ padding: '16px 8px', fontWeight: 500 }}>Type</th>
                    <th style={{ padding: '16px 8px', fontWeight: 500 }}>Description</th>
                    <th style={{ padding: '16px 8px', fontWeight: 500, textAlign: 'right' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((tx: any) => (
                    <tr key={tx.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '16px 8px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {format(new Date(tx.createdAt), 'MMM d, yyyy HH:mm')}
                      </td>
                      <td style={{ padding: '16px 8px' }}>
                        <span style={{ 
                          padding: '4px 8px', 
                          backgroundColor: 'var(--bg-secondary)',
                          color: 'var(--text-primary)',
                          borderRadius: '4px',
                          fontSize: '12px',
                          fontWeight: 500
                        }}>
                          {getTransactionTypeLabel(tx.type)}
                        </span>
                      </td>
                      <td style={{ padding: '16px 8px' }}>
                        {tx.description || '-'}
                      </td>
                      <td style={{ padding: '16px 8px', fontWeight: 600, textAlign: 'right', color: getAmountColor(tx.type, tx.amount) }}>
                        {formatAmount(tx.type, tx.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            {data.totalPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '24px', paddingTop: '16px', borderTop: '1px solid var(--border)' }}>
                <div style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
                  Showing page {data.page} of {data.totalPages} (Total: {data.total})
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button 
                    className="btn btn-secondary" 
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={data.page === 1 || loading}
                    style={{ padding: '8px 12px' }}
                  >
                    <ChevronLeft size={16} /> Prev
                  </button>
                  <button 
                    className="btn btn-secondary" 
                    onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
                    disabled={data.page === data.totalPages || loading}
                    style={{ padding: '8px 12px' }}
                  >
                    Next <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-secondary)' }}>
            No transaction history found.
          </div>
        )}
      </div>
    </div>
  );
}
