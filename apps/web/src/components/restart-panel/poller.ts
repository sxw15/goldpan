// apps/web/src/components/restart-panel/poller.ts
//
// Shared "wait for server to come back" polling used by both:
//   - components/restart-panel/restart-panel.tsx — the standalone restart
//     panel on /onboarding/complete and /settings#about
//   - app/settings/settings-shell.tsx — the per-field "reset + restart"
//     one-shot driven from account.tsx (login password reset)
//
// A single ok read of `/api/health` is a point-in-time signal — no
// guarantee the server stays reachable long enough for the next SSR hop.
// Earlier iterations bet on a fixed post-ok settle delay (2s, then 5s);
// both still raced on slow boxes and during the supervisor cascade where
// the freshly listening port could be replaced before the redirect fires.
// Replace the bet with a stability streak: require K consecutive ok reads
// (any failure resets the streak) plus a final probe of
// `/runtime-info/effective-env` — the same hop SSR's i18n setup makes
// before FeedPage's first SDK call. The final probe catches the case
// where `/api/health` flapped ok but the middleware → server rewrite path
// (which SSR would also use) isn't yet reliable. Without it the user's
// reload races the SSR i18n loader; locale falls back to envLocale ('en')
// and the whole UI renders in English until the user manually refreshes
// once more.
//
// We deliberately don't fetch `/` itself: that would burn a Next page
// compile we'd re-trigger post-redirect.

export const REQUIRED_CONSECUTIVE_OK = 3;
export const POLL_INTERVAL_MS = 1000;
export const DEFAULT_POLL_TIMEOUT_MS = 60_000;
/**
 * Settle window between `POST /server/restart` returning 200 and the first
 * `/health` probe. The restart handler responds 200 *before* scheduling its
 * own `setTimeout(200ms)` → shutdown, so for ~200ms the old process is still
 * happily answering /health. Without a settle delay, the very first poll
 * read counts that "old-process ok" toward the consecutive-ok streak.
 * `pollForReady` already drops the streak when /health later flips
 * unreachable, so the worst case is a one-tick false positive in the streak,
 * but at the SDK contract level the client is expected to honour
 * `estimatedSeconds` from the restart response. 500 ms is comfortably > the
 * 200 ms exit timer and well under the typical supervisor relaunch window. */
export const DEFAULT_INITIAL_DELAY_MS = 500;

/** SSR readiness probe — mirrors what `apps/web/src/i18n/request.ts`
 *  fetches on every page render. If middleware can rewrite to it AND the
 *  server can respond, SSR's locale path will succeed; the FeedPage SDK
 *  call rides the same hop. We tolerate either 200 or any non-network
 *  status — only `fetch failed` (TCP refused / abort) counts as not-ready. */
export async function ssrPathProbe(): Promise<boolean> {
  try {
    const r = await fetch('/api/runtime-info/effective-env', {
      signal: AbortSignal.timeout(2000),
    });
    return r.status < 500;
  } catch {
    return false;
  }
}

/** Single probe used by the on-mount resume path to decide whether the
 *  server is already live (in which case there's nothing to wait for and
 *  the stale flag should be cleared) vs. mid-restart (poll). Mirrors the
 *  health-status discrimination used by `pollForReady`. */
export async function probeServerLive(): Promise<boolean> {
  try {
    const r = await fetch('/api/health', { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return false;
    const body = (await r.json()) as { status?: string };
    return body.status === 'ok' || body.status === 'degraded';
  } catch {
    return false;
  }
}

/** Poll `/api/health` until K consecutive ok reads land, then confirm the
 *  SSR path (`/api/runtime-info/effective-env`) responds. Returns 'ready'
 *  on success, 'timeout' once `timeoutMs` elapses without satisfying
 *  both gates. Caller is responsible for the post-ready action (reload /
 *  redirect) and for any phase callback updates.
 *
 *  `initialDelayMs` defaults to {@link DEFAULT_INITIAL_DELAY_MS} so callers
 *  driven by a fresh `POST /server/restart` 200 give the old process time
 *  to enter shutdown before the first probe; callers using this for resume
 *  (RestartPanel's `useEffect` after a mid-restart reload) can pass `0`
 *  to skip the wait — there's no fresh exit-timer to coordinate with. */
export async function pollForReady(opts?: {
  timeoutMs?: number;
  initialDelayMs?: number;
}): Promise<'ready' | 'timeout'> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const initialDelayMs = opts?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  if (initialDelayMs > 0) {
    await new Promise((s) => setTimeout(s, initialDelayMs));
  }
  const start = Date.now();
  let consecutiveOk = 0;
  while (Date.now() - start < timeoutMs) {
    let okThisTime = false;
    try {
      const r = await fetch('/api/health', { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const body = (await r.json()) as { status?: string };
        okThisTime = body.status === 'ok' || body.status === 'degraded';
      }
    } catch {
      // Server briefly down between exit and rebind — keep polling.
    }
    if (okThisTime) {
      consecutiveOk++;
      if (consecutiveOk >= REQUIRED_CONSECUTIVE_OK) {
        if (await ssrPathProbe()) {
          return 'ready';
        }
        // SSR path probe failed — the streak was a lie. Reset and keep
        // polling instead of redirecting into a half-ready server.
        consecutiveOk = 0;
      }
    } else {
      consecutiveOk = 0;
    }
    await new Promise((s) => setTimeout(s, POLL_INTERVAL_MS));
  }
  return 'timeout';
}
