'use client';

import { useTranslations } from 'next-intl';
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { ConfirmModal } from './confirm-modal';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations('common');
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOpts(null);
    resolve?.(ok);
  }, []);

  const confirm = useCallback<ConfirmFn>((next) => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current?.(false);
      resolverRef.current = resolve;
      setOpts(next);
    });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {opts ? (
        <ConfirmModal
          open
          title={opts.title ?? t('confirm_default_title')}
          message={opts.message}
          confirmLabel={opts.confirmLabel ?? t('ok')}
          cancelLabel={opts.cancelLabel ?? t('cancel')}
          danger={opts.danger}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      ) : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider');
  return ctx;
}
