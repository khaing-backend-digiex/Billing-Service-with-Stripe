'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { Package, Plus } from 'lucide-react';
import LoadingSpinner from '@/components/LoadingSpinner';

export default function AdminCatalogPage() {
  const [plans, setPlans] = useState<any[]>([]);
  const [addons, setAddons] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'plans' | 'addons'>('plans');

  const fetchCatalog = async () => {
    setLoading(true);
    try {
      const [plansRes, addonsRes] = await Promise.all([
        api.get('/pricing/plans'),
        api.get('/pricing/addons'),
      ]);
      setPlans(plansRes.data);
      setAddons(addonsRes.data);
    } catch (err) {
      console.error('Failed to load catalog', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCatalog();
  }, []);

  const formatPrice = (price: number) => new Intl.NumberFormat('vi-VN').format(price) + '₫';

  return (
    <div style={{ padding: '40px', maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '32px' }}>
        <h1 className="h1">Catalog Management</h1>
        <button className="btn btn-primary" onClick={() => alert('Editing catalog via UI is coming soon! Please use the database seed script to update the catalog for now.')}>
          <Plus size={18} style={{ marginRight: '8px' }} /> Create New
        </button>
      </div>

      <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', borderBottom: '1px solid var(--border)' }}>
        <button
          onClick={() => setActiveTab('plans')}
          style={{
            padding: '12px 16px',
            backgroundColor: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'plans' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'plans' ? 'var(--text-primary)' : 'var(--text-secondary)',
            fontWeight: 500,
            fontSize: '14px'
          }}
        >
          Pricing Plans
        </button>
        <button
          onClick={() => setActiveTab('addons')}
          style={{
            padding: '12px 16px',
            backgroundColor: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'addons' ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeTab === 'addons' ? 'var(--text-primary)' : 'var(--text-secondary)',
            fontWeight: 500,
            fontSize: '14px'
          }}
        >
          Addon Packages
        </button>
      </div>

      {loading ? (
        <LoadingSpinner message="Loading catalog..." />
      ) : activeTab === 'plans' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '24px' }}>
          {plans.map((plan: any) => (
            <div key={plan.code} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
                <h3 className="h3">{plan.name}</h3>
                <span style={{ 
                  padding: '2px 8px', 
                  backgroundColor: 'var(--bg-tertiary)',
                  borderRadius: '4px',
                  fontSize: '12px',
                  fontWeight: 500
                }}>
                  {plan.code}
                </span>
              </div>
              
              <div style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '16px' }}>
                {plan.creditPolicy?.creditAmount} credits / {plan.creditPolicy?.resetInterval}
              </div>

              <div style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase' }}>Pricing Options</div>
                {plan.pricingOptions?.map((opt: any) => (
                  <div key={opt.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', fontSize: '14px' }}>
                    <span>{opt.billingCycle.name}</span>
                    <span style={{ fontWeight: 500 }}>{formatPrice(opt.price)}</span>
                  </div>
                ))}
                {plan.isFree && <div style={{ fontSize: '14px', fontStyle: 'italic' }}>Free Plan</div>}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '24px' }}>
          {addons.map((addon: any) => (
            <div key={addon.id} className="card" style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                <h3 className="h3">{addon.name}</h3>
                <span style={{ 
                  padding: '2px 8px', 
                  backgroundColor: addon.isActive ? 'rgba(16, 163, 127, 0.1)' : 'rgba(239, 65, 70, 0.1)',
                  color: addon.isActive ? 'var(--accent)' : 'var(--danger)',
                  borderRadius: '4px',
                  fontSize: '12px',
                  fontWeight: 500
                }}>
                  {addon.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '24px' }}>{addon.code}</div>
              
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto' }}>
                <div style={{ fontSize: '18px', fontWeight: 600, color: 'var(--accent)' }}>+{addon.credits} credits</div>
                <div style={{ fontSize: '18px', fontWeight: 600 }}>{formatPrice(addon.price)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
