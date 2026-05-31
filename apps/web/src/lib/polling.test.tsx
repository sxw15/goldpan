import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTaskPolling } from './polling';

// useTaskPolling owns the consumer-visible distinction between a deleted task
// (notFound → calm tombstone) and a transport failure (error → red styling).
// The 404 branch is the only one we exercise at the hook level: it returns
// `shouldContinue:false`, so the poll loop exits on the first fetch with NO
// setTimeout — clean to assert without driving fake timers. Other branches
// (5xx/network) loop with exponential-backoff timers and are covered indirectly
// by the bubble tombstone component tests instead.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const ORIGINAL_FETCH = global.fetch;

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('useTaskPolling — 404 → notFound', () => {
  it('sets notFound:true and error:null when the task returns 404', async () => {
    const fetchMock = vi.fn(async () => ({ status: 404, ok: false }));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const { result } = renderHook(() =>
      useTaskPolling({ taskId: 42, intervalMs: 3000, t: (k) => k }),
    );

    await waitFor(() => expect(result.current.notFound).toBe(true));
    expect(result.current.error).toBeNull();
    expect(result.current.data).toBeNull();
    // Loop exits immediately on 404 — only one fetch, no retry/backoff.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/42', expect.anything());
  });
});
