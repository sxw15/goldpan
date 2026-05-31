'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CmdKPalette } from './cmdk-palette';

interface CmdKContextValue {
  open: boolean;
  /**
   * 打开/关闭面板。打开时传入触发元素（按钮/链接），关闭后焦点还原到它。
   * 面板已开时再次 open 不覆盖 triggerRef —— 否则 ⌘K 连按会把 palette
   * input 写回 triggerRef，关闭后 focus 打到 unmounted 节点，焦点掉到 body。
   */
  setOpen: (v: boolean, trigger?: HTMLElement | null) => void;
}

const CmdKContext = createContext<CmdKContextValue | null>(null);

export function useCmdK(): CmdKContextValue {
  const ctx = useContext(CmdKContext);
  if (!ctx) {
    throw new Error('useCmdK must be used within <CmdKProvider>');
  }
  return ctx;
}

export function CmdKProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpenState] = useState(false);
  const openRef = useRef(false);
  const triggerRef = useRef<HTMLElement | null>(null);

  const setOpen = useCallback((v: boolean, trigger?: HTMLElement | null) => {
    if (v && !openRef.current && trigger) {
      triggerRef.current = trigger;
    }
    openRef.current = v;
    setOpenState(v);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true, document.activeElement as HTMLElement | null);
        return;
      }
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setOpen]);

  useEffect(() => {
    if (!open) {
      triggerRef.current?.focus({ preventScroll: true });
      triggerRef.current = null;
    }
  }, [open]);

  const value = useMemo<CmdKContextValue>(() => ({ open, setOpen }), [open, setOpen]);

  return (
    <CmdKContext.Provider value={value}>
      {children}
      <CmdKPalette />
    </CmdKContext.Provider>
  );
}
