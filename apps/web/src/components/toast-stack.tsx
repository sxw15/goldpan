'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastKind = 'success' | 'danger' | undefined;

export interface ToastInput {
  msg: string;
  kind?: ToastKind;
  /** Time-to-live in ms. 0 disables auto-dismiss. Default 3500. */
  ttl?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastEntry extends ToastInput {
  id: string;
}

interface ToastApi {
  push: (toast: ToastInput) => string;
  dismiss: (id: string) => void;
}

export function useToastStack(): { toasts: ToastEntry[]; api: ToastApi } {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const dismiss = useCallback((id: string) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
    if (timers.current[id]) {
      clearTimeout(timers.current[id]);
      delete timers.current[id];
    }
  }, []);

  const push = useCallback(
    (toast: ToastInput) => {
      const id = crypto.randomUUID();
      const ttl = toast.ttl ?? 3500;
      setToasts((ts) => [...ts, { id, ...toast }]);
      if (ttl > 0) {
        timers.current[id] = setTimeout(() => dismiss(id), ttl);
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const id of Object.keys(t)) clearTimeout(t[id]);
    };
  }, []);

  return { toasts, api: { push, dismiss } };
}

interface ToastStackProps {
  toasts: ToastEntry[];
  dismiss: (id: string) => void;
  closeLabel: string;
}

export function ToastStack({ toasts, dismiss, closeLabel }: ToastStackProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="gp-toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="gp-toast" data-variant={t.kind} role="alert">
          <span className="gp-toast__msg">{t.msg}</span>
          {t.action && (
            <button
              type="button"
              className="gp-toast__btn"
              onClick={() => {
                // optional chain: TS narrowing from outer `t.action &&` does
                // not carry into this closure, so `t.action` is widened back
                // to `T | undefined` here.
                t.action?.onClick();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            className="gp-toast__close"
            aria-label={closeLabel}
            onClick={() => dismiss(t.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
