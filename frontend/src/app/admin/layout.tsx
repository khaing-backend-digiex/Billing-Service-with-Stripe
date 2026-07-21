'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/store/authStore';
import { LayoutDashboard, CreditCard, Zap, PlusSquare, History, Settings, LogOut, Bot, Users, Package } from 'lucide-react';

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { isAuthenticated, initialize, user, logout } = useAuthStore();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    initialize();
    setMounted(true);
  }, [initialize]);

  useEffect(() => {
    if (mounted) {
      if (!isAuthenticated) {
        router.push('/login');
      } else if (!user?.roles?.includes('admin')) {
        router.push('/dashboard');
      }
    }
  }, [mounted, isAuthenticated, user, router]);

  if (!mounted || !isAuthenticated || !user?.roles?.includes('admin')) {
    return <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center' }}>Checking access...</div>;
  }

  const navItems = [
    { name: 'Overview', href: '/dashboard', icon: LayoutDashboard },
    { name: 'Subscription', href: '/dashboard/subscription', icon: PlusSquare },
    { name: 'Credits', href: '/dashboard/credits', icon: Zap },
    { name: 'Addon Store', href: '/dashboard/addons', icon: Package },
    { name: 'Payment Methods', href: '/dashboard/payment-methods', icon: CreditCard },
    { name: 'Payment History', href: '/dashboard/payments', icon: History },
    { name: 'Settings', href: '/dashboard/settings', icon: Settings },
  ];

  const adminItems = [
    { name: 'Admin Overview', href: '/admin', icon: LayoutDashboard },
    { name: 'Users', href: '/admin/users', icon: Users },
    { name: 'Catalog', href: '/admin/catalog', icon: Package },
  ];

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* Sidebar */}
      <aside style={{ width: '260px', backgroundColor: 'var(--bg-sidebar)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '24px', borderBottom: '1px solid var(--border)' }}>
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '18px' }}>
            <Bot size={24} color="var(--accent)" />
            DigiCredit
          </Link>
        </div>

        <div style={{ padding: '16px 12px', flex: 1, overflowY: 'auto' }}>
          <nav style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {navItems.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    backgroundColor: isActive ? 'var(--bg-tertiary)' : 'transparent',
                    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontWeight: isActive ? 500 : 400,
                  }}
                >
                  <item.icon size={18} color={isActive ? 'var(--accent)' : 'currentColor'} />
                  {item.name}
                </Link>
              );
            })}

            <div style={{ margin: '24px 12px 8px', fontSize: '12px', fontWeight: 600, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Admin
            </div>
            {adminItems.map((item) => {
              const isActive = pathname.startsWith(item.href) && (item.href !== '/admin' || pathname === '/admin');
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    backgroundColor: isActive ? 'var(--bg-tertiary)' : 'transparent',
                    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontWeight: isActive ? 500 : 400,
                  }}
                >
                  <item.icon size={18} color={isActive ? 'var(--accent)' : 'currentColor'} />
                  {item.name}
                </Link>
              );
            })}
          </nav>
        </div>

        <div style={{ padding: '16px 12px', borderTop: '1px solid var(--border)' }}>
          <button
            onClick={() => {
              logout();
              router.push('/login');
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '8px 12px',
              width: '100%',
              borderRadius: '6px',
              backgroundColor: 'transparent',
              color: 'var(--text-secondary)',
              border: 'none',
              textAlign: 'left'
            }}
          >
            <LogOut size={18} />
            Log out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main style={{ flex: 1, backgroundColor: 'var(--bg-primary)', overflowY: 'auto' }}>
        {children}
      </main>
    </div>
  );
}
