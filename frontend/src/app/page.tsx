import PublicNav from '@/components/PublicNav';
import Link from 'next/link';
import { ArrowRight, Zap, Shield, CreditCard } from 'lucide-react';

export default function LandingPage() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <PublicNav />
      
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '80px 20px' }}>
        <section style={{ textAlign: 'center', maxWidth: '800px', marginBottom: '80px' }} className="animate-fade-in">
          <h1 className="h1" style={{ fontSize: '56px', lineHeight: 1.1, marginBottom: '24px', letterSpacing: '-0.03em' }}>
            Supercharge your workflow with AI credits
          </h1>
          <p className="body-text" style={{ fontSize: '20px', color: 'var(--text-secondary)', marginBottom: '40px', maxWidth: '600px', margin: '0 auto 40px' }}>
            Access powerful AI models with a flexible credit system. Pay only for what you use, or subscribe for monthly allowances.
          </p>
          <div style={{ display: 'flex', gap: '16px', justifyContent: 'center' }}>
            <Link href="/register" className="btn btn-primary" style={{ fontSize: '16px', padding: '12px 24px' }}>
              Get Started <ArrowRight size={18} style={{ marginLeft: '8px' }} />
            </Link>
            <Link href="/pricing" className="btn btn-secondary" style={{ fontSize: '16px', padding: '12px 24px' }}>
              View Pricing
            </Link>
          </div>
        </section>

        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '32px', width: '100%', maxWidth: '1000px' }}>
          <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '32px' }}>
            <div style={{ padding: '12px', backgroundColor: 'rgba(16, 163, 127, 0.1)', borderRadius: '8px', marginBottom: '20px' }}>
              <Zap size={24} color="var(--accent)" />
            </div>
            <h3 className="h3" style={{ marginBottom: '12px' }}>Lightning Fast</h3>
            <p style={{ color: 'var(--text-secondary)' }}>Experience zero latency and instant credit updates with our optimized infrastructure.</p>
          </div>
          <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '32px' }}>
            <div style={{ padding: '12px', backgroundColor: 'rgba(16, 163, 127, 0.1)', borderRadius: '8px', marginBottom: '20px' }}>
              <CreditCard size={24} color="var(--accent)" />
            </div>
            <h3 className="h3" style={{ marginBottom: '12px' }}>Flexible Billing</h3>
            <p style={{ color: 'var(--text-secondary)' }}>Choose between free tier, monthly subscriptions, or one-time credit addons when you need more.</p>
          </div>
          <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '32px' }}>
            <div style={{ padding: '12px', backgroundColor: 'rgba(16, 163, 127, 0.1)', borderRadius: '8px', marginBottom: '20px' }}>
              <Shield size={24} color="var(--accent)" />
            </div>
            <h3 className="h3" style={{ marginBottom: '12px' }}>Enterprise Secure</h3>
            <p style={{ color: 'var(--text-secondary)' }}>Your payment details are safely vaulted with Stripe, ensuring maximum security and compliance.</p>
          </div>
        </section>
      </main>

      <footer style={{ borderTop: '1px solid var(--border)', padding: '40px 20px', textAlign: 'center', color: 'var(--text-secondary)' }}>
        <p>© 2026 DigiCredit. All rights reserved.</p>
      </footer>
    </div>
  );
}
