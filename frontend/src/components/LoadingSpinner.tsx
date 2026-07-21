import { Loader2 } from 'lucide-react';

export default function LoadingSpinner({ fullPage = false, message = 'Loading...' }: { fullPage?: boolean; message?: string }) {
  const content = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', color: 'var(--text-secondary)' }}>
      <Loader2 size={32} color="var(--accent)" style={{ animation: 'spin 1s linear infinite' }} />
      {message && <div style={{ fontSize: '14px', fontWeight: 500 }}>{message}</div>}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );

  if (fullPage) {
    return (
      <div style={{ display: 'flex', height: '100%', minHeight: '50vh', width: '100%', alignItems: 'center', justifyContent: 'center' }}>
        {content}
      </div>
    );
  }

  return (
    <div style={{ padding: '40px', display: 'flex', justifyContent: 'center' }}>
      {content}
    </div>
  );
}
