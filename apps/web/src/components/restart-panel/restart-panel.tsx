// apps/web/src/components/restart-panel/restart-panel.tsx
//
// One-click restart UI shared between `/onboarding/complete` (post-wizard
// hand-off into normal mode) and `/settings#about` (operator-initiated
// restart from inside the running app). Behaviour splits on the supervisor
// reported by `/api/onboarding/runtime-info` (wizard mode) or
// `/api/runtime-info/supervisor` (normal mode):
//
//   - 'docker' / 'supervised' / 'unknown' → AutoRestartPanel: a primary
//     button that POSTs `/api/server/restart`, then polls `/api/health` for
//     up to 60 s until the server is back. On success, navigate to '/'. The
//     'unknown' branch shows a hint up-front because we can't promise the
//     supervisor will relaunch.
//
//   - 'concurrently' (pnpm dev / pnpm start) → ManualRestartPanel: NO
//     destructive button. concurrently's `--kill-others` tears down both
//     server and web on any child exit, so a web-triggered POST would just
//     leave the user staring at a dead page. Instead we render a numbered
//     instruction list with a copy-to-clipboard button for the rerun command,
//     and a hint pointing to start:supervised / docker for users who actually
//     want one-click web restart.
//
// Polling target is `/api/health` (proxies to server `/health`), NOT
// `/api/healthz` (filesystem route in the web app, always returns ok and
// gives no signal about wizard vs normal mode).
//
// Restart-POST error model: a connection drop is the expected case (server
// exits before responding) — we swallow that and start polling. A 4xx / 5xx
// response means the server processed the POST and refused — polling for 60 s
// would just hide the error, so we surface 'post_failed' immediately.
//
// i18n is keyed by the `tNamespace` prop so each call site picks its own
// message namespace (`onboarding.complete` / `settings.about.restart`).
// The expected keys are listed in REQUIRED_MESSAGE_KEYS below.
'use client';
import { Check, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Btn } from '@/components/ui/button';
import { performRestart } from './perform-restart';
import { pollForReady, probeServerLive } from './poller';
import { clearRestartFlag, readRestartFlag } from './restart-flag';

type AutoPhase = 'idle' | 'restarting' | 'timeout' | 'post_failed';
export type Supervisor = 'docker' | 'supervised' | 'concurrently' | 'unknown';

/**
 * Required message keys under `tNamespace`:
 * - auto_restart_heading, auto_restart_body
 * - auto_restart_unknown_hint, auto_restart_split_web_hint
 * - auto_restart_button, auto_restart_in_progress
 * - auto_restart_timeout, auto_restart_post_failed
 * - manual_restart_heading, manual_restart_body
 * - manual_restart_step_terminal, manual_restart_step_rerun
 * - manual_restart_command, manual_restart_copy, manual_restart_copied
 * - manual_restart_one_click_hint
 */
export interface RestartPanelProps {
  supervisor: Supervisor;
  /** next-intl namespace that holds the message keys above. */
  tNamespace: string;
  /** Where to navigate after a successful restart. Defaults to '/'. */
  redirectTo?: string;
}

export function RestartPanel({ supervisor, tNamespace, redirectTo = '/' }: RestartPanelProps) {
  if (supervisor === 'concurrently') {
    return <ManualRestartPanel tNamespace={tNamespace} />;
  }
  return (
    <AutoRestartPanel supervisor={supervisor} tNamespace={tNamespace} redirectTo={redirectTo} />
  );
}

function AutoRestartPanel({
  supervisor,
  tNamespace,
  redirectTo,
}: {
  supervisor: Exclude<Supervisor, 'concurrently'>;
  tNamespace: string;
  redirectTo: string;
}) {
  const t = useTranslations(tNamespace);
  const [phase, setPhase] = useState<AutoPhase>('idle');

  // Resume polling on remount (browser reload mid-restart). Three distinct
  // remount paths reach this effect with the flag still set:
  //
  //   1. SSR caught the restart cascade (network retry covered the server
  //      boot window) and the page rendered successfully. Server is
  //      already live AND the user is on the redirectTo page — there is
  //      nothing to wait for, just clear the flag so we don't re-trigger
  //      polling + redirect on top of an already-good page.
  //   2. SSR failed, `app/error.tsx` polled + reloaded; now we're back on
  //      the fresh page. Same outcome as 1.
  //   3. Onboarding-style: the page that hosts the RestartPanel is NOT
  //      the redirect target. E.g. `/onboarding/complete` has
  //      redirectTo='/'. After a successful restart the user must end up
  //      on '/'. Normally middleware redirects /onboarding/* → / once
  //      wizard mode flips off, so we never land here — but if the
  //      browser's `wizard-locale` cookie is still set during the brief
  //      window middleware uses it as a fallback, we can land back on
  //      /onboarding/complete with the server already live. We still
  //      need to honor the panel's contract and navigate to redirectTo.
  //   4. The browser was force-reloaded mid-cascade (next-dev hard reload
  //      while server was still booting). Server may still be down; poll
  //      until it comes up.
  //
  // A single probe of /api/health discriminates 1+2+3 from 4 cheaply.
  // For 1+2+3 we then compare the current pathname against redirectTo:
  // same → stay, different → navigate. Without this, case 3 silently
  // strands the user on /onboarding/complete after a successful restart.
  useEffect(() => {
    if (!readRestartFlag()) return;
    let cancelled = false;
    void (async () => {
      const live = await probeServerLive();
      if (cancelled) return;
      if (live) {
        clearRestartFlag();
        if (shouldNavigateToRedirect(redirectTo)) {
          window.location.assign(redirectTo);
        }
        return;
      }
      setPhase('restarting');
      // Resume path (page remounted mid-restart): old-process exit-timer
      // already elapsed before we got here, so skip the initial settle —
      // we'd just be sleeping for nothing.
      const result = await pollForReady({ initialDelayMs: 0 });
      if (cancelled) return;
      if (result === 'ready') {
        clearRestartFlag();
        window.location.assign(redirectTo);
      } else {
        setPhase('timeout');
        clearRestartFlag();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [redirectTo]);

  async function clickRestart() {
    setPhase('restarting');
    // performRestart owns the full lifecycle: setRestartFlag → POST
    // (tolerating connection drop) → pollForReady → navigate. The
    // restart flag's clear happens either via the next page's resume
    // effect (success path) or inside performRestart's failure
    // branches. Phase is only flipped on failure here — the success
    // path is already navigating.
    const r = await performRestart({ redirectTo });
    if (!r.ok) {
      setPhase(r.reason === 'timeout' ? 'timeout' : 'post_failed');
    }
  }

  return (
    <div className="gp-restart-panel">
      <h3 className="gp-restart-panel__title">{t('auto_restart_heading')}</h3>
      <p className="gp-restart-panel__body">{t('auto_restart_body')}</p>
      {supervisor === 'unknown' && (
        <p className="gp-restart-panel__hint">{t('auto_restart_unknown_hint')}</p>
      )}
      <p className="gp-restart-panel__hint">{t('auto_restart_split_web_hint')}</p>
      <div className="gp-restart-panel__action">
        {phase === 'idle' && (
          <Btn kind="primary" onClick={clickRestart}>
            {t('auto_restart_button')}
          </Btn>
        )}
        {phase === 'restarting' && (
          <p className="gp-restart-panel__status">{t('auto_restart_in_progress')}</p>
        )}
        {phase === 'timeout' && (
          <p className="gp-restart-panel__status gp-restart-panel__status--error">
            {t('auto_restart_timeout')}
          </p>
        )}
        {phase === 'post_failed' && (
          <p className="gp-restart-panel__status gp-restart-panel__status--error">
            {t('auto_restart_post_failed')}
          </p>
        )}
      </div>
    </div>
  );
}

function ManualRestartPanel({ tNamespace }: { tNamespace: string }) {
  const t = useTranslations(tNamespace);
  const command = t('manual_restart_command');
  const [copied, setCopied] = useState(false);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API blocked (insecure context, permissions denied) — the
      // command is still visible inline so the user can copy by hand. We
      // intentionally don't surface a UI error: the action's primary path
      // (read the command on screen) still works.
    }
  }

  return (
    <div className="gp-restart-panel">
      <h3 className="gp-restart-panel__title">{t('manual_restart_heading')}</h3>
      <p className="gp-restart-panel__body">{t('manual_restart_body')}</p>
      <ol className="gp-restart-panel__steps">
        <li>{t('manual_restart_step_terminal')}</li>
        <li>
          <span>{t('manual_restart_step_rerun')}</span>
          <div className="gp-restart-panel__cmd">
            <code className="gp-restart-panel__cmd-code">{command}</code>
            <button
              type="button"
              className="gp-restart-panel__cmd-copy"
              onClick={copyCommand}
              aria-label={copied ? t('manual_restart_copied') : t('manual_restart_copy')}
            >
              {copied ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Copy size={14} aria-hidden="true" />
              )}
              <span>{copied ? t('manual_restart_copied') : t('manual_restart_copy')}</span>
            </button>
          </div>
        </li>
      </ol>
      <p className="gp-restart-panel__hint">{t('manual_restart_one_click_hint')}</p>
    </div>
  );
}

/** Compare the current location against the panel's redirectTo. Returns
 *  true iff the user is NOT already on the exact target route (in which case
 *  the caller should `location.assign(redirectTo)`). Query params matter for
 *  settings sub-routes such as `/settings?group=about`; treating `/settings`
 *  as equivalent would strand the user on the default settings group after a
 *  mid-restart reload. */
function shouldNavigateToRedirect(redirectTo: string): boolean {
  try {
    const target = new URL(redirectTo, window.location.origin);
    return (
      target.pathname !== window.location.pathname ||
      target.search !== window.location.search ||
      target.hash !== window.location.hash
    );
  } catch {
    // Unparseable redirectTo — err on the side of navigating so the
    // panel's contract (deliver the user to the target) is honored.
    return true;
  }
}
