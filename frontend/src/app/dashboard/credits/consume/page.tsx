'use client';

import { useState } from 'react';
import api from '@/lib/api';
import { AlertCircle, ArrowLeft, CheckCircle } from 'lucide-react';
import Link from 'next/link';

export default function ConsumeCreditPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  
  const [formData, setFormData] = useState({
    productId: 'prod_ai_default',
    amount: 1,
    description: 'Generated an AI image'
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      await api.post('/credits/consume', {
        ...formData,
        referenceId: `mock-${Date.now()}`, // Mock a unique reference ID
        idempotencyKey: `idk-${Date.now()}-${Math.random().toString(36).substr(2, 9)}` // Mock a unique idempotency key
      });
      setSuccess(`Successfully consumed ${formData.amount} credit(s).`);
    } catch (err: any) {
      console.error('Failed to consume credit', err);
      setError(err.response?.data?.message || 'Failed to consume credit.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '40px', maxWidth: '600px', margin: '0 auto' }}>
      <div style={{ marginBottom: '32px', display: 'flex', alignItems: 'center', gap: '16px' }}>
        <Link href="/dashboard/credits" className="btn btn-secondary" style={{ padding: '8px' }}>
          <ArrowLeft size={20} />
        </Link>
        <h1 className="h1" style={{ margin: 0 }}>Simulate Credit Usage</h1>
      </div>

      <div className="card">
        <p className="body-text" style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>
          Use this form to test consuming credits. This simulates an API call from a resource server (e.g. image generation service) deducting credits from the user's balance.
        </p>

        {error && (
          <div style={{ padding: '16px', backgroundColor: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: '8px', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertCircle size={20} />
            {error}
          </div>
        )}

        {success && (
          <div style={{ padding: '16px', backgroundColor: 'var(--success-bg)', color: 'var(--success)', borderRadius: '8px', marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle size={20} />
            {success}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500 }}>Product ID</label>
            <input 
              type="text" 
              value={formData.productId}
              onChange={(e) => setFormData({...formData, productId: e.target.value})}
              className="input" 
              style={{ width: '100%', padding: '12px', borderRadius: '6px', border: '1px solid var(--border)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
              required 
            />
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500 }}>Amount to Consume</label>
            <input 
              type="number" 
              min="1"
              value={formData.amount}
              onChange={(e) => setFormData({...formData, amount: parseInt(e.target.value) || 0})}
              className="input" 
              style={{ width: '100%', padding: '12px', borderRadius: '6px', border: '1px solid var(--border)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
              required 
            />
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500 }}>Description</label>
            <input 
              type="text" 
              value={formData.description}
              onChange={(e) => setFormData({...formData, description: e.target.value})}
              className="input" 
              style={{ width: '100%', padding: '12px', borderRadius: '6px', border: '1px solid var(--border)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
              required 
            />
          </div>

          <button 
            type="submit" 
            className="btn btn-primary" 
            style={{ marginTop: '16px', padding: '12px', fontSize: '16px' }}
            disabled={loading}
          >
            {loading ? 'Consuming...' : 'Consume Credits'}
          </button>
        </form>
      </div>
    </div>
  );
}
