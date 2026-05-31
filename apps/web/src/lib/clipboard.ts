'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

interface UseCopyToClipboardResult {
  copied: boolean;
  copy: (text: string) => Promise<boolean>;
  /** Manually clear `copied`; e.g. dialogs that re-open should reset feedback. */
  reset: () => void;
}

// Wraps the "set copied → setTimeout reset" pattern duplicated across
// several copy buttons. Cancels a pending reset timer if the user clicks
// again before it fires, and on unmount.
export function useCopyToClipboard(resetMs = 1500): UseCopyToClipboardResult {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const reset = useCallback(() => {
    clearTimer();
    setCopied(false);
  }, [clearTimer]);

  const copy = useCallback(
    async (text: string) => {
      const ok = await copyToClipboard(text);
      if (ok) {
        clearTimer();
        setCopied(true);
        timerRef.current = setTimeout(() => {
          setCopied(false);
          timerRef.current = null;
        }, resetMs);
      }
      return ok;
    },
    [clearTimer, resetMs],
  );

  return { copied, copy, reset };
}
