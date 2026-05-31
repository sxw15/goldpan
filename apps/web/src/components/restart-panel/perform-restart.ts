// apps/web/src/components/restart-panel/perform-restart.ts
//
// Unified restart driver, shared by both the standalone RestartPanel (on
// /onboarding/complete and /settings#about) and the settings shell's
// per-field reset+restart helper (account.tsx login-password reset path).
//
// Before this consolidation the two implementations diverged on three
// behaviours that all turned out to matter:
//
//   1. **Restart flag**. RestartPanel set sessionStorage 'restarting' via
//      setRestartFlag() so app/error.tsx (and WizardStateProvider) could
//      distinguish "we asked for a restart" from "server is randomly down".
//      The settings path skipped this — a 5xx during the restart window
//      surfaced as a generic error page instead of the restart-aware
//      polling UI.
//   2. **Connection-drop tolerance**. The server schedules its shutdown
//      ~200ms after responding 200 to POST /server/restart, but on dev
//      hot-reload / certain supervisor cascades the response is never
//      flushed; the client sees a network error. RestartPanel correctly
//      treated this as "POST succeeded, server is exiting"; settings'
//      `client.serverRestart()` call let the rejection propagate to
//      catch (err), which then ran rethrowNextErrors + toasted "failed"
//      while the restart had actually started.
//   3. **redirectTo vs reload**. RestartPanel can navigate to a target
//      page (e.g. '/' from /onboarding/complete); settings only ever
//      reloaded. Unifying lets a future settings flow direct the user
//      somewhere else without reimplementing the lifecycle.
//
// pollForReady (the K-consecutive-ok + SSR-path-probe loop) was already
// shared; this helper just owns the surrounding setup + teardown.
'use client';

import { pollForReady } from './poller';
import { clearRestartFlag, setRestartFlag } from './restart-flag';

export type PerformRestartResult =
  | { ok: true }
  /** Server actively refused the POST (4xx/5xx response). Distinct from
   *  the connection-drop path, which the helper treats as the expected
   *  "POST succeeded, server is now exiting" signal. */
  | { ok: false; reason: 'post_failed' }
  /** pollForReady's 60s window elapsed without K consecutive /health OKs
   *  + an SSR-path probe. Server may still be coming back — the caller's
   *  recovery copy should hint at a manual refresh. */
  | { ok: false; reason: 'timeout' };

export interface PerformRestartOptions {
  /** Fires when the POST has settled (or was tolerated as a connection
   *  drop) and pollForReady is about to begin. Used to flip caller UI
   *  from "restarting…" to "polling for server back". */
  onPolling?: () => void;
  /** Target URL once the server is ready. Default: reload the current
   *  page. /onboarding/complete passes '/' so the post-restart redirect
   *  lands on the main app instead of bouncing back through onboarding. */
  redirectTo?: string;
  /** Override the default 60s pollForReady timeout. */
  pollTimeoutMs?: number;
}

/** Drive the full restart cycle: flag → POST → poll → navigate. Returns
 *  a tagged result so callers can branch on the failure mode (post_failed
 *  vs timeout) without inspecting separate error types.
 *
 *  Success path: this function does not resolve `{ ok: true }` before
 *  triggering the navigation, so most callers won't observe the success
 *  branch — the page is already navigating. The return value exists so
 *  the type system still typechecks the union exhaustively at the call
 *  site. */
export async function performRestart(
  opts: PerformRestartOptions = {},
): Promise<PerformRestartResult> {
  // Set BEFORE the POST so a browser-initiated reload triggered by the
  // server's exit (next dev HMR, supervisor cascade) reaches the
  // RestartPanel's resume effect / app/error.tsx still seeing the flag.
  // The clear happens either via the resume effect on the post-reload
  // page (success path) or via the explicit clear-and-bail branches
  // below (failure paths).
  setRestartFlag();

  let posted = false;
  try {
    const r = await fetch('/api/server/restart', { method: 'POST' });
    posted = r.ok;
  } catch {
    // ANY fetch failure is tolerated as "POST succeeded, server is
    // exiting":
    //
    //   - Most common: connection drop. server schedules shutdown ~200ms
    //     after the 200 response; in some environments the response never
    //     makes it back to the client before the socket closes.
    //   - Less common but indistinguishable at the fetch API level:
    //     firewall block, CSP refusal, DNS failure, browser AbortError,
    //     generic TypeError on network. The fetch spec doesn't expose
    //     enough taxonomy for client code to discriminate cleanly.
    //
    // Worst-case impact of the tolerance: if the request never reached
    // the server, the 60s pollForReady window will time out and surface
    // 'timeout' to the caller — better UX than showing 'post_failed' on
    // a request that may have actually started the restart but had its
    // response flush interrupted. The caller can suggest a manual
    // refresh on timeout; users investigating "why no restart" can
    // check the network panel / server logs.
    posted = true;
  }

  if (!posted) {
    // Server returned 4xx/5xx — actively refused. Polling for 60s would
    // just hide the error.
    clearRestartFlag();
    return { ok: false, reason: 'post_failed' };
  }

  opts.onPolling?.();

  const result = await pollForReady({ timeoutMs: opts.pollTimeoutMs });
  if (result === 'timeout') {
    clearRestartFlag();
    return { ok: false, reason: 'timeout' };
  }

  // pollForReady → 'ready'. Navigate. We deliberately do NOT clear the
  // flag here: a window.location.assign / reload starts the navigation
  // asynchronously, and clearing now would orphan the post-reload
  // resume path if the navigation itself fails (e.g. blocked by a
  // browser extension or a service worker). The next page's mount
  // re-runs the resume effect, probes /api/health to confirm the
  // server is up, and clears the flag at that point.
  if (opts.redirectTo !== undefined) {
    window.location.assign(opts.redirectTo);
  } else {
    window.location.reload();
  }
  return { ok: true };
}
