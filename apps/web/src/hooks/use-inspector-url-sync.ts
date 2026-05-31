'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import type { InspectorKind, InspectorPayload } from '../components/inspector/payloads/types';
import { parseFocusId, parseInspectorKind } from '../lib/url';

/**
 * Synchronize Inspector entry-level payload with URL `?focus=<id>&kind=<entity|source|...>`.
 *
 * - URL only tracks the **entry** payload; the Inspector's internal 2-level stack
 *   (push/pop from within a payload's relation chip, etc.) is session-only, not URL-synced.
 * - `allowedKinds[0]` is the default kind; when URL has `?focus=<id>` without `kind`,
 *   fallback to the first allowed kind → keeps S1 shape `?focus=42` working.
 * - When opening a payload of the default kind, the `kind` param is omitted from the URL
 *   to keep URLs short and backward-compatible.
 *
 * **Call-site discipline:** `allowedKinds` must be a module-level readonly constant
 * (e.g. `const LIBRARY_KINDS = ['entity','source'] as const`), NOT an inline literal.
 * Fresh array identity per render would break `useMemo` / `useCallback` deps,
 * causing repeated recomputes and stale downstream memoization.
 */
export function useInspectorUrlSync(allowedKinds: readonly InspectorKind[]) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const payload = useMemo((): InspectorPayload | null => {
    const id = parseFocusId(searchParams.get('focus'));
    if (id === null) return null;
    const rawKind = searchParams.get('kind');
    // Legacy alias: pre-P5 SourceViewPayload was a source-detail view exposed as `kind=note`.
    // P5 introduced a real user-note kind. Only rewrite if `note` is NOT itself an
    // allowed kind; otherwise the real `kind=note` would be silently aliased to source.
    const normalizedKind =
      rawKind === 'note' && !allowedKinds.includes('note') && allowedKinds.includes('source')
        ? 'source'
        : rawKind;
    const kind = parseInspectorKind(normalizedKind, allowedKinds, allowedKinds[0]);
    return { kind, id } as InspectorPayload;
  }, [searchParams, allowedKinds]);

  const open = useCallback(
    (next: InspectorPayload) => {
      const params = new URLSearchParams(searchParams);
      params.set('focus', String(next.id));
      if (next.kind === allowedKinds[0]) {
        params.delete('kind');
      } else {
        params.set('kind', next.kind);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname, searchParams, allowedKinds],
  );

  const close = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    params.delete('focus');
    params.delete('kind');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [router, pathname, searchParams]);

  return { payload, open, close };
}
