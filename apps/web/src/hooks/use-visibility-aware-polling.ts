'use client';

import { useEffect, useRef } from 'react';

/**
 * Run `callback` every `intervalMs` while the tab is visible. When the tab is
 * hidden the timer is cleared; when it becomes visible again the callback
 * fires immediately to catch up, then the interval resumes.
 *
 * Uses a ref to read the latest `callback` so a fresh-each-render closure
 * (forgotten useCallback) does not reset the timer.
 */
export function useVisibilityAwarePolling(callback: () => void, intervalMs: number): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (typeof document === 'undefined') return;

    let timerId: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timerId !== null) return;
      timerId = setInterval(() => callbackRef.current(), intervalMs);
    };
    const stop = () => {
      if (timerId === null) return;
      clearInterval(timerId);
      timerId = null;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        callbackRef.current();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [intervalMs]);
}
