'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bot } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';

export default function PublicNav() {
  const pathname = usePathname();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  return (
    <nav style={{ 
      display: 'flex', 
      justifyContent: 'space-between', 
      alignItems: 'center', 
      padding: '24px 40px',
      borderBottom: '1px solid var(--border)'
    }}>
      <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '20px' }}>
        <Bot size={28} color="var(--accent)" />
        DigiCredit
      </Link>
      <div style={{ display: 'flex', gap: '24px', alignItems: 'center' }}>
        <Link href="/pricing" style={{ color: pathname === '/pricing' ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
          Pricing
        </Link>
        {isAuthenticated ? (
          <Link href="/dashboard" className="btn btn-secondary">
            Dashboard
          </Link>
        ) : (
          <div style={{ display: 'flex', gap: '12px' }}>
            <Link href="/login" className="btn btn-secondary">
              Log in
            </Link>
            <Link href="/register" className="btn btn-primary">
              Sign up
            </Link>
          </div>
        )}
      </div>
    </nav>
  );
}
