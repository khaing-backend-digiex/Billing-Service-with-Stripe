'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { User, Mail, ExternalLink, User as UserIcon } from 'lucide-react';
import LoadingSpinner from '@/components/LoadingSpinner';
import { format } from 'date-fns';
import { useToast } from '@/components/Toast';

export default function SettingsPage() {
  const toast = useToast();
  const { user } = useAuthStore();
  const [userData, setUserData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);

  useEffect(() => {
    const fetchUser = async () => {
      if (!user?.id) {
        setUserData(user); // Fallback to what we have in store
        setLoading(false);
        return;
      }
      
      try {
        const res = await api.get(`/users/${user.id}`);
        setUserData(res.data.data);
      } catch (err) {
        console.error('Failed to load user data', err);
        setUserData(user); // Fallback
      } finally {
        setLoading(false);
      }
    };
    fetchUser();
  }, [user]);

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
      toast.error('Failed to open billing portal. Please try again.');
    } finally {
      setPortalLoading(false);
    }
  };

  if (loading) return <LoadingSpinner message="Loading settings..." />

  return (
    <div style={{ padding: '40px', maxWidth: '800px', margin: '0 auto' }}>
      <h1 className="h1" style={{ marginBottom: '32px' }}>Settings</h1>

      <div className="card" style={{ marginBottom: '32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
          <UserIcon color="var(--accent)" />
          <h2 className="h2">Account Information</h2>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '16px', alignItems: 'center' }}>
          <div style={{ color: 'var(--text-secondary)' }}>Full Name</div>
          <div style={{ fontWeight: 500 }}>{userData?.name || 'N/A'}</div>

          <div style={{ color: 'var(--text-secondary)' }}>Email Address</div>
          <div style={{ fontWeight: 500 }}>{userData?.email}</div>

          <div style={{ color: 'var(--text-secondary)' }}>Role</div>
          <div>
            {userData?.roles?.map((role: string) => (
              <span key={role} style={{ 
                padding: '2px 8px', 
                backgroundColor: 'var(--bg-tertiary)', 
                borderRadius: '4px',
                fontSize: '12px',
                marginRight: '8px',
                textTransform: 'capitalize'
              }}>
                {role}
              </span>
            ))}
          </div>

          {userData?.createdAt && (
            <>
              <div style={{ color: 'var(--text-secondary)' }}>Member Since</div>
              <div>{format(new Date(userData.createdAt), 'MMMM d, yyyy')}</div>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <h2 className="h2" style={{ marginBottom: '16px' }}>Stripe Billing Portal</h2>
        <p className="body-text" style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>
          Manage your subscription, payment methods, and view your complete billing history directly on Stripe.
        </p>
        <button 
          onClick={handleOpenPortal} 
          disabled={portalLoading}
          className="btn btn-secondary"
          style={{ display: 'flex', gap: '8px' }}
        >
          {portalLoading ? 'Opening...' : 'Open Billing Portal'} <ExternalLink size={16} />
        </button>
      </div>
    </div>
  );
}
