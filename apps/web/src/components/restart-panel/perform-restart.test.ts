// apps/web/src/components/restart-panel/perform-restart.test.ts
//
// Covers the four branches of the unified restart driver: POST success,
// POST connection drop (expected — treated as success), POST refused
// (4xx/5xx → post_failed), and pollForReady timeout. Also asserts the
// restart flag lifecycle (set up front, cleared only on failure paths
// so the post-reload resume effect can still see it) and the
// reload-vs-assign navigation choice.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./restart-flag', () => ({
  setRestartFlag: vi.fn(),
  clearRestartFlag: vi.fn(),
}));
vi.mock('./poller', () => ({
  pollForReady: vi.fn(),
}));

import { performRestart } from './perform-restart';
import { pollForReady } from './poller';
import { clearRestartFlag, setRestartFlag } from './restart-flag';

const originalLocation = window.location;
// Stash the original `fetch` reference so afterEach can restore it.
// Without this, any test that assigned `global.fetch = vi.fn()...` leaks
// the mock across to the next test inside the same file (vi.clearAllMocks
// only resets call records, not the binding) — and in principle could
// affect later test files if vitest ever switches off file-level
// isolation. Stash + restore keeps each test self-contained.
const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom blocks reassigning window.location; redefine via defineProperty
  // so we can spy on assign/reload without the helper actually navigating.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign: vi.fn(), reload: vi.fn() },
    writable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: originalLocation,
    writable: true,
  });
  global.fetch = originalFetch;
});

describe('performRestart', () => {
  test('happy path: POST ok + pollForReady ready → reload, flag stays set', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    (pollForReady as ReturnType<typeof vi.fn>).mockResolvedValue('ready');
    const r = await performRestart();
    expect(setRestartFlag).toHaveBeenCalledOnce();
    expect(r).toEqual({ ok: true });
    expect(window.location.reload).toHaveBeenCalledOnce();
    expect(window.location.assign).not.toHaveBeenCalled();
    // Deliberately NOT cleared on success — the next page's resume effect
    // probes /api/health, confirms the server is up, and clears the flag.
    // If we cleared here a blocked navigation (extension / service worker)
    // would orphan the resume signal.
    expect(clearRestartFlag).not.toHaveBeenCalled();
  });

  test('connection drop is tolerated as POST success', async () => {
    // Server schedules shutdown ~200ms after the 200 response. On some
    // supervisors / dev hot-reload the response never flushes and the
    // fetch rejects. Treat as "POST succeeded, server is exiting" —
    // polling will pick up the new process.
    global.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    (pollForReady as ReturnType<typeof vi.fn>).mockResolvedValue('ready');
    const r = await performRestart();
    expect(r).toEqual({ ok: true });
    expect(window.location.reload).toHaveBeenCalledOnce();
    expect(clearRestartFlag).not.toHaveBeenCalled();
  });

  test('POST returns !ok → post_failed, flag cleared, no polling', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false } as Response);
    const r = await performRestart();
    expect(r).toEqual({ ok: false, reason: 'post_failed' });
    expect(clearRestartFlag).toHaveBeenCalledOnce();
    expect(pollForReady).not.toHaveBeenCalled();
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  test('pollForReady timeout → timeout result, flag cleared, no nav', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    (pollForReady as ReturnType<typeof vi.fn>).mockResolvedValue('timeout');
    const r = await performRestart();
    expect(r).toEqual({ ok: false, reason: 'timeout' });
    expect(clearRestartFlag).toHaveBeenCalledOnce();
    expect(window.location.reload).not.toHaveBeenCalled();
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  test('redirectTo navigates via location.assign instead of reload', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    (pollForReady as ReturnType<typeof vi.fn>).mockResolvedValue('ready');
    await performRestart({ redirectTo: '/onboarding/done' });
    expect(window.location.assign).toHaveBeenCalledWith('/onboarding/done');
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  test('onPolling fires after the POST settled, before pollForReady', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    (pollForReady as ReturnType<typeof vi.fn>).mockImplementation(async () => 'ready');
    const onPolling = vi.fn();
    await performRestart({ onPolling });
    expect(onPolling).toHaveBeenCalledOnce();
  });

  test('onPolling does NOT fire when POST returns !ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false } as Response);
    const onPolling = vi.fn();
    await performRestart({ onPolling });
    expect(onPolling).not.toHaveBeenCalled();
  });
});
