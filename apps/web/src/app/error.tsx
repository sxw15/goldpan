'use client';

import { useEffect, useState } from 'react';
import { clearRestartFlag, readRestartFlag } from '@/components/restart-panel/restart-flag';

// NOTE: This error boundary intentionally uses hardcoded bilingual strings
// rather than useTranslations(). When this component renders, the parent
// component tree (including NextIntlClientProvider) may have unmounted due
// to the error. Calling useTranslations() here could throw, causing an
// infinite error loop. Bilingual text ensures both language audiences are
// served without depending on i18n infrastructure.

const REQUIRED_CONSECUTIVE_OK = 3;
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 60_000;

// Phase order: 'mounting' is the SSR + pre-effect state — `readRestartFlag`
// reads sessionStorage which is unavailable on the server, so deciding
// 'restarting' vs 'error' inside useState's initializer would render one
// thing during SSR and a different thing on first client render
// (hydration mismatch + a frame of "Something went wrong" that flips to
// "重启中"). We commit the choice in useEffect instead, which only runs
// post-hydration; SSR/first-render returns null. The intermediate blank
// frame is preferable to a misleading flash.
type Phase = 'mounting' | 'restarting' | 'timeout' | 'error';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Restart-aware mode: when the user triggered an in-progress server restart
  // (RestartPanel set the sessionStorage flag before POST /server/restart),
  // the cascade brings web down too — when the new web boots, next-dev
  // hard-reloads the browser, which races the still-booting server and
  // SSR fetch lands here as ECONNREFUSED. Showing the generic "Something
  // went wrong" page would be a lie: the user is mid-restart and the right
  // affordance is "wait then come back to where you were", not "try again".
  // We poll /api/health from the browser (the same probe RestartPanel uses)
  // and reload the current URL once the server is real.
  const [phase, setPhase] = useState<Phase>('mounting');

  useEffect(() => {
    if (!readRestartFlag()) {
      console.error('Unhandled error:', error);
      setPhase('error');
      return;
    }
    setPhase('restarting');
    let cancelled = false;
    pollForReady().then((ok) => {
      if (cancelled) return;
      if (ok) {
        clearRestartFlag();
        // Reload the current URL — the SSR fetch that landed us here will
        // re-run against the now-live server. We don't reset() because the
        // error boundary's reset path keeps client-side state from the
        // failed render; a full reload guarantees a clean SSR.
        window.location.reload();
      } else {
        clearRestartFlag();
        setPhase('timeout');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [error]);

  // SSR + pre-hydration: minimal spinner. The phase commit happens in the
  // first effect (synchronous post-hydration) so this is single-render-tick
  // brief in practice — but rendering a spinner instead of `null` avoids a
  // visible blank frame when SSR took several seconds (the budget the
  // network retry burned before throwing) and bridges into the restart /
  // error UI without a content jump.
  if (phase === 'mounting') {
    return (
      <div className="gp-error">
        <span className="gp-error__spinner" aria-hidden="true" />
      </div>
    );
  }

  if (phase === 'restarting') {
    return (
      <div className="gp-error">
        <h2>Restarting / 重启中</h2>
        <p className="gp-error__message">
          The server is coming back up. This page will reload automatically.
          <br />
          服务正在恢复，本页将自动刷新。
        </p>
        <p className="gp-error__message gp-error__message--muted">
          <span className="gp-error__spinner" aria-hidden="true" />
        </p>
      </div>
    );
  }

  if (phase === 'timeout') {
    return (
      <div className="gp-error">
        <h2>Restart timed out / 重启超时</h2>
        <p className="gp-error__message">
          The server didn't come back within 60 seconds. Check the supervisor status, then reload
          manually.
          <br />
          服务在 60 秒内未恢复，请检查 supervisor 状态后手动刷新。
        </p>
        <button type="button" onClick={() => window.location.reload()} className="gp-error__retry">
          Reload / 刷新
        </button>
      </div>
    );
  }

  return (
    <div className="gp-error">
      <h2>Something went wrong / 出现错误</h2>
      <p className="gp-error__message">
        An unexpected error occurred. Please try again.
        <br />
        发生了意外错误，请重试。
      </p>
      <button type="button" onClick={reset} className="gp-error__retry">
        Try again / 重试
      </button>
    </div>
  );
}

// Mirrors the polling contract used by RestartPanel: K consecutive ok reads
// of /api/health PLUS a final probe of /api/runtime-info/effective-env (the
// hop SSR's i18n setup makes on every page render). We can't reuse the
// RestartPanel function directly because this file must be standalone —
// importing too much from elsewhere risks pulling in code paths that
// themselves throw at boundary-render time.
async function pollForReady(): Promise<boolean> {
  const start = Date.now();
  let consecutiveOk = 0;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
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
        if (await ssrPathProbe()) return true;
        consecutiveOk = 0;
      }
    } else {
      consecutiveOk = 0;
    }
    await new Promise((s) => setTimeout(s, POLL_INTERVAL_MS));
  }
  return false;
}

async function ssrPathProbe(): Promise<boolean> {
  try {
    const r = await fetch('/api/runtime-info/effective-env', {
      signal: AbortSignal.timeout(2000),
    });
    return r.status < 500;
  } catch {
    return false;
  }
}
