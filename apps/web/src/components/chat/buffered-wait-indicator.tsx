'use client';

import { useTranslations } from 'next-intl';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface Props {
  messageId: number;
  expiresAt: number;
  waitReasonKey: string;
  onRelease: (id: number) => void;
  onCancel: (id: number) => void;
}

// Trigger release 500ms before the server-side `expiresAt` to absorb clock
// skew between client and server — the server is the authority and will reject
// late releases. See plan §"二轮 review N7" + spec §"取舍 12".
const PRE_EXPIRE_BUFFER_MS = 500;

/**
 * Visual indicator for buffered (waiting) intent classifier messages. Shows the
 * waitReason text, a per-second countdown text node, a CSS-animated progress
 * bar that drains over the full window, and two action buttons (execute now /
 * cancel). Auto-releases via a single setTimeout 500ms before `expiresAt`.
 *
 * Wrapped in `React.memo` so parent re-renders (e.g. the chat message list
 * mutating around it) don't reset the countdown / progress animation. Per-second
 * `setState` is isolated to `useCountdownSeconds` below so the rerender footprint
 * stays at one text node.
 */
export const BufferedWaitIndicator = memo(function BufferedWaitIndicator({
  messageId,
  expiresAt,
  waitReasonKey,
  onRelease,
  onCancel,
}: Props) {
  const t = useTranslations('intent_classifier');
  const tCommon = useTranslations('common');

  // Prevent double-click → double-API: once we've kicked off either path the
  // ref latches and subsequent clicks (or the auto-release timer) are no-ops.
  const releasedRef = useRef(false);
  const handleRelease = useCallback(() => {
    if (releasedRef.current) return;
    releasedRef.current = true;
    onRelease(messageId);
  }, [messageId, onRelease]);
  const handleCancel = useCallback(() => {
    if (releasedRef.current) return;
    releasedRef.current = true;
    onCancel(messageId);
  }, [messageId, onCancel]);

  // Single setTimeout for auto-release — explicitly NOT a per-second tick that
  // also triggers release, because per-second setState on the indicator root
  // would invalidate the CSS animation and cascade into the parent.
  useEffect(() => {
    const delay = Math.max(0, expiresAt - Date.now() - PRE_EXPIRE_BUFFER_MS);
    const timer = setTimeout(handleRelease, delay);
    return () => clearTimeout(timer);
  }, [expiresAt, handleRelease]);

  // Animation duration is the full remaining window so the bar reaches scaleX(0)
  // right at `expiresAt`. We freeze it on mount of this expiresAt value (the
  // `useMemo` dependency) — when expiresAt changes (rare: server extended the
  // window) we recompute.
  const animationDuration = useMemo(() => `${Math.max(0, expiresAt - Date.now())}ms`, [expiresAt]);

  return (
    <div className="gp-buffered-wait" role="status" aria-live="polite">
      <div className="gp-buffered-wait__reason">{t(`wait_reason.${waitReasonKey}`)}</div>
      <CountdownText expiresAt={expiresAt} />
      <div className="gp-buffered-wait__progress" style={{ animationDuration }} aria-hidden />
      <div className="gp-buffered-wait__actions">
        <button type="button" className="gp-buffered-wait__release" onClick={handleRelease}>
          {t('execute_now_button')}
        </button>
        <button type="button" className="gp-buffered-wait__cancel" onClick={handleCancel}>
          {tCommon('cancel')}
        </button>
      </div>
    </div>
  );
});

/**
 * Isolated child component so the per-second setState only re-renders this
 * text node, not the surrounding indicator (progress bar animation stays
 * intact, buttons don't reflow).
 */
function CountdownText({ expiresAt }: { expiresAt: number }) {
  const seconds = useCountdownSeconds(expiresAt);
  return <div className="gp-buffered-wait__countdown">{seconds}s</div>;
}

function useCountdownSeconds(expiresAt: number): number {
  const [s, setS] = useState(() => Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
  useEffect(() => {
    const id = setInterval(() => {
      const next = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setS(next);
      if (next <= 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return s;
}
