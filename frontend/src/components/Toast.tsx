'use client';

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  ReactNode,
} from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';

type ToastVariant = 'success' | 'error' | 'warning' | 'info';

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
  leaving?: boolean;
}

interface ToastApi {
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
  show: (message: string, variant?: ToastVariant, duration?: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const VARIANT_STYLE: Record<
  ToastVariant,
  { color: string; bg: string; Icon: typeof CheckCircle }
> = {
  success: { color: 'var(--success)', bg: 'var(--success-bg)', Icon: CheckCircle },
  error: { color: 'var(--danger)', bg: 'var(--danger-bg)', Icon: XCircle },
  warning: { color: 'var(--warning)', bg: 'var(--warning-bg)', Icon: AlertTriangle },
  info: { color: 'var(--accent)', bg: 'var(--accent-bg)', Icon: Info },
};

const DEFAULT_DURATION = 4000;
const EXIT_DURATION = 250;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => {
    // Trigger exit animation, then unmount.
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
    );
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, EXIT_DURATION);
  }, []);

  const show = useCallback(
    (message: string, variant: ToastVariant = 'info', duration = DEFAULT_DURATION) => {
      const id = ++idRef.current;
      setToasts((prev) => [...prev, { id, message, variant, duration }]);
      if (duration > 0) {
        setTimeout(() => remove(id), duration);
      }
    },
    [remove],
  );

  const api: ToastApi = {
    show,
    success: (m, d) => show(m, 'success', d),
    error: (m, d) => show(m, 'error', d),
    warning: (m, d) => show(m, 'warning', d),
    info: (m, d) => show(m, 'info', d),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        style={{
          position: 'fixed',
          top: '20px',
          right: '20px',
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          maxWidth: 'min(400px, calc(100vw - 40px))',
          pointerEvents: 'none',
        }}
      >
        {toasts.map((t) => {
          const { color, bg, Icon } = VARIANT_STYLE[t.variant];
          return (
            <div
              key={t.id}
              role="status"
              style={{
                position: 'relative',
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '12px',
                padding: '14px 16px',
                backgroundColor: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderLeft: `3px solid ${color}`,
                borderRadius: '8px',
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
                color: 'var(--text-primary)',
                fontSize: '14px',
                lineHeight: 1.4,
                pointerEvents: 'auto',
                animation: t.leaving
                  ? `toastOut ${EXIT_DURATION}ms cubic-bezier(0.16, 1, 0.3, 1) forwards`
                  : 'toastIn 300ms cubic-bezier(0.16, 1, 0.3, 1)',
              }}
            >
              <div
                style={{
                  flexShrink: 0,
                  width: '28px',
                  height: '28px',
                  borderRadius: '6px',
                  backgroundColor: bg,
                  color,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon size={18} />
              </div>

              <span style={{ flex: 1, paddingTop: '4px' }}>{t.message}</span>

              <button
                onClick={() => remove(t.id)}
                aria-label="Dismiss"
                style={{
                  flexShrink: 0,
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  padding: '2px',
                  display: 'flex',
                  alignItems: 'center',
                  transition: 'color 150ms ease',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
              >
                <X size={16} />
              </button>

              {t.duration > 0 && !t.leaving && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: '2px',
                    backgroundColor: color,
                    transformOrigin: 'left',
                    animation: `toastProgress ${t.duration}ms linear forwards`,
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}
