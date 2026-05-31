'use client';
import type { DigestDataSnapshot, DigestRenderPreset } from '@goldpan/web-sdk';
import { useCallback, useMemo } from 'react';
import { Inspector } from '@/components/inspector/inspector';
import { useInspectorUrlSync } from '@/hooks/use-inspector-url-sync';
import { DigestSections } from './digest-sections';

const DIGEST_KINDS = ['source', 'entity'] as const;
const SEVEN_DAYS_MS = 7 * 86400 * 1000;

export function DigestShell({
  snapshot,
  preset,
  channel,
}: {
  snapshot: DigestDataSnapshot;
  /** Render preset; `null` falls back to DigestSections' all-slots default. */
  preset: DigestRenderPreset | null;
  /** Threaded through to DigestHero so the failed-AI-summary CTA can deep-link to /settings?channel=…. */
  channel?: string;
}) {
  const { payload, open, close } = useInspectorUrlSync(DIGEST_KINDS);
  const onOpenSource = useCallback((id: number) => open({ kind: 'source', id }), [open]);
  const onOpenEntity = useCallback((id: number) => open({ kind: 'entity', id }), [open]);
  // Pin the connections window once per shell mount. Without this, every
  // Inspector toggle (open/close source/entity) re-rendered DigestShell ->
  // DigestSections, where an inline `Date.now() - 7d` produced a fresh
  // `sinceMs` prop, which re-fired ConnectionsSection's
  // `useEffect([sinceMs])` and re-fetched /digest/connections — one extra
  // round-trip per click.
  const connectionsSinceMs = useMemo(() => Date.now() - SEVEN_DAYS_MS, []);
  return (
    <>
      <DigestSections
        snapshot={snapshot}
        preset={preset}
        pageContext="main"
        connectionsSinceMs={connectionsSinceMs}
        onOpenSource={onOpenSource}
        onOpenEntity={onOpenEntity}
        channel={channel}
      />
      <Inspector payload={payload} onClose={close} />
    </>
  );
}
