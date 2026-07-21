'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import Link from 'next/link';
import { Users, Package } from 'lucide-react';

export default function AdminOverview() {
  const [stats, setStats] = useState({ users: 0, plans: 0, addons: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const [usersRes, plansRes, addonsRes] = await Promise.all([
          api.get('/users'),
          api.get('/pricing/plans'),
          api.get('/pricing/addons'),
        ]);
        
        setStats({
          users: usersRes.data.data?.length || 0,
          plans: plansRes.data?.length || 0,
          addons: addonsRes.data?.length || 0,
        });
      } catch (err) {
        console.error('Failed to load admin stats', err);
      } finally {
        setLoading(false);
      }
    };
    fetchStats();
  }, []);

  if (loading) return <div style={{ padding: '40px' }}>Loading admin dashboard...</div>;

  return (
    <div style={{ padding: '40px', maxWidth: '1000px', margin: '0 auto' }}>
      <h1 className="h1" style={{ marginBottom: '32px' }}>Admin Dashboard</h1>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '24px', marginBottom: '40px' }}>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <Users size={32} color="var(--accent)" style={{ marginBottom: '16px' }} />
          <div style={{ fontSize: '32px', fontWeight: 700, marginBottom: '8px' }}>{stats.users}</div>
          <div style={{ color: 'var(--text-secondary)' }}>Total Users</div>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <Package size={32} color="var(--accent)" style={{ marginBottom: '16px' }} />
          <div style={{ fontSize: '32px', fontWeight: 700, marginBottom: '8px' }}>{stats.plans}</div>
          <div style={{ color: 'var(--text-secondary)' }}>Pricing Plans</div>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <Package size={32} color="var(--accent)" style={{ marginBottom: '16px' }} />
          <div style={{ fontSize: '32px', fontWeight: 700, marginBottom: '8px' }}>{stats.addons}</div>
          <div style={{ color: 'var(--text-secondary)' }}>Addon Packages</div>
        </div>
      </div>

      <div className="card">
        <h2 className="h2" style={{ marginBottom: '16px' }}>Quick Actions</h2>
        <div style={{ display: 'flex', gap: '16px' }}>
          <Link href="/admin/users" className="btn btn-secondary">
            Manage Users
          </Link>
          <Link href="/admin/catalog" className="btn btn-secondary">
            Manage Catalog
          </Link>
        </div>
      </div>
    </div>
  );
}
