'use client';
import { Check } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { RestartPanel } from '@/components/restart-panel/restart-panel';
import { Notice } from '@/components/ui/notice';
import { SettingsHead } from '@/components/ui/settings-head';

type Supervisor = 'docker' | 'supervised' | 'concurrently' | 'unknown';

/**
 * Pure success / next-steps page. Reachable only via redirect from the auth
 * step's commit handler (which is also where validation/submit errors are
 * shown). Kept on a separate URL so the user gets a clear "you're done"
 * landmark after the wizard's 5 config steps.
 *
 * The seed-failed warning rides in via `?seed_failed=1` — it's a one-shot
 * signal, not persisted state, and we surface it inline at the top of the
 * page so the user doesn't assume their digest / tracking presets saved.
 *
 * Layout intentionally drops the redundant SettingsCard wrapper around the
 * restart action — the page's only job after success is to get the user
 * into normal mode, so the action gets full visual weight via RestartPanel
 * (which renders an auto-restart CTA or manual-instruction list depending
 * on the detected supervisor).
 */
export default function CompletePage() {
  const t = useTranslations('onboarding.complete');
  const tProgress = useTranslations('onboarding.progress');
  const params = useSearchParams();
  const seedFailed = params?.get('seed_failed') === '1';
  const [supervisor, setSupervisor] = useState<Supervisor>('unknown');

  useEffect(() => {
    let alive = true;
    fetch('/api/onboarding/runtime-info')
      .then((r) => r.json() as Promise<{ supervisor: Supervisor }>)
      .then((d) => {
        if (alive) setSupervisor(d.supervisor);
      })
      .catch((err) => {
        // RestartPanel's 'unknown' branch still gives the user a manual
        // path, so we don't surface a UI error — but log so deployers
        // debugging a wedged install can see why the supervisor probe
        // failed.
        console.warn('runtime-info probe failed', err);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <SettingsHead crumb={tProgress('complete')} heading={t('completed_title')} />
      <p className="gp-onboarding-complete-saved">
        <Check size={14} aria-hidden="true" />
        <span>{t('saved_status')}</span>
      </p>
      {seedFailed && (
        <Notice kind="warn" heading={t('metadata_seed_warning_title')}>
          {t('metadata_seed_warning_body')}
        </Notice>
      )}
      <RestartPanel supervisor={supervisor} tNamespace="onboarding.complete" />
      <p className="gp-onboarding-helper gp-onboarding-complete-demos">
        <a
          className="gp-onboarding-link"
          href={t('demo_video_youtube')}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('watch_youtube')}
        </a>
        <span className="gp-onboarding-link-sep">·</span>
        <a
          className="gp-onboarding-link"
          href={t('demo_video_bilibili')}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('watch_bilibili')}
        </a>
      </p>
    </>
  );
}
