'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { RestartPanel, type Supervisor } from '@/components/restart-panel/restart-panel';
import { Btn } from '@/components/ui/button';
import { SettingsCard } from '@/components/ui/settings-card';
import { SettingsField } from '@/components/ui/settings-field';
import { SettingsHead } from '@/components/ui/settings-head';
import type { GroupProps } from '../settings-shell';
import { useFieldTagLabels } from '../use-field-tag-labels';

export function GroupAbout({ toast }: GroupProps) {
  const t = useTranslations('settings.about');
  const fieldTagLabels = useFieldTagLabels();
  // Mirrors the probe in /onboarding/complete: 'unknown' is the safe default
  // until the supervisor probe resolves; AutoRestartPanel renders an extra
  // hint in that branch so the user is warned before clicking.
  const [supervisor, setSupervisor] = useState<Supervisor>('unknown');

  useEffect(() => {
    let alive = true;
    fetch('/api/runtime-info/supervisor')
      .then((r) => r.json() as Promise<{ supervisor: Supervisor }>)
      .then((d) => {
        if (alive) setSupervisor(d.supervisor);
      })
      .catch((err) => {
        // Same posture as the onboarding-complete probe: keep `unknown`,
        // log so a deployer debugging a wedged install can see why the
        // probe failed. The 'unknown' branch still surfaces the manual hint.
        console.warn('runtime-info/supervisor probe failed', err);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <SettingsHead crumb={t('crumb')} heading={t('heading')} />
      {/* RestartPanel renders its own bordered surface (shared with the
        onboarding "complete" page) so it sits inline between SettingsHead
        and the regular SettingsCards rather than nested inside one — that
        keeps the visual exactly the same as the onboarding flow and avoids
        double border / padding. */}
      <div className="gp-settings-restart-slot">
        <RestartPanel
          supervisor={supervisor}
          tNamespace="settings.about.restart"
          redirectTo="/settings?group=about"
        />
      </div>
      <SettingsCard heading={t('card_links')}>
        <SettingsField
          tagLabels={fieldTagLabels}
          label={t('field_docs_label')}
          control={
            <Btn
              sm
              onClick={() => {
                window.open('https://goldpan.dev/docs', '_blank', 'noopener');
                toast({ msg: t('toast_open_docs') });
              }}
            >
              {t('open_button')}
            </Btn>
          }
        />
        <SettingsField
          tagLabels={fieldTagLabels}
          label={t('field_source_label')}
          control={
            <Btn
              sm
              onClick={() => {
                window.open('https://github.com/goldpan/goldpan', '_blank', 'noopener');
                toast({ msg: t('toast_open_github') });
              }}
            >
              {t('open_button')}
            </Btn>
          }
        />
      </SettingsCard>
    </>
  );
}
