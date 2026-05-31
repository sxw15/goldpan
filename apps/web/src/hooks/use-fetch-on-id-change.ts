'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type FetchState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: Error };

interface UseFetchOnIdChangeOptions<T> {
  /** Bumping forces a refetch even when `id` doesn't change (e.g. after a mutation). */
  retryKey?: number;
  /** Called once per successful fetch; used to bubble titles up to inspector header. */
  onReady?: (data: T) => void;
}

interface UseFetchOnIdChangeResult<T> {
  state: FetchState<T>;
  /** Triggers a refetch with the current `id`; wire to StateError's retry button. */
  retry: () => void;
}

// Threads `controller.signal` to the SDK so the underlying request is aborted
// on id-change / unmount; `fetcher` / `onReady` are ref-captured so caller
// closures don't re-fire the effect on every render.
export function useFetchOnIdChange<T>(
  id: number,
  fetcher: (id: number, signal: AbortSignal) => Promise<T>,
  options?: UseFetchOnIdChangeOptions<T>,
): UseFetchOnIdChangeResult<T> {
  const [state, setState] = useState<FetchState<T>>({ status: 'loading' });
  const [internalRetry, setInternalRetry] = useState(0);
  const externalRetry = options?.retryKey ?? 0;

  const fetcherRef = useRef(fetcher);
  const onReadyRef = useRef(options?.onReady);
  fetcherRef.current = fetcher;
  onReadyRef.current = options?.onReady;

  // biome-ignore lint/correctness/useExhaustiveDependencies: internalRetry / externalRetry are intentional refetch sentinels — bumping them re-runs the effect even when id is unchanged.
  useEffect(() => {
    setState({ status: 'loading' });
    const controller = new AbortController();
    fetcherRef
      .current(id, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ status: 'ready', data });
        onReadyRef.current?.(data);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // Aborted requests reject as `DOMException('AbortError')`; suppress
        // so a quick id-change doesn't surface a phantom error to the user.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState({
          status: 'error',
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
    return () => controller.abort();
  }, [id, internalRetry, externalRetry]);

  const retry = useCallback(() => setInternalRetry((k) => k + 1), []);
  return { state, retry };
}
