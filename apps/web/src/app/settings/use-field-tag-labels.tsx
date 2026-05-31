'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { FieldTagLabels } from '@/components/ui/settings-field';

/**
 * Resolves SettingsField tagLabels from the `settings.a11y` i18n namespace.
 * Each settings group calls this once and passes the result to each
 * SettingsField that uses `restart` / `env` / `readonly` props.
 */
export function useFieldTagLabels(): FieldTagLabels {
  const t = useTranslations('settings.a11y');
  const tShell = useTranslations('settings.shell');
  const tRestart = useTranslations('settings.about.restart');
  const serviceNavLinkLabel = `${tShell('section_system')} · ${tShell('group_about')}`;
  return {
    restart: t('field_tag_restart'),
    restartHint: (
      <>
        {t('field_tag_restart_hint_lead')}
        <Link
          href="/settings?group=about"
          scroll={false}
          className="gp-tag-tip__link"
          prefetch={false}
        >
          {serviceNavLinkLabel}
        </Link>
        {t('field_tag_restart_hint_tail', {
          button: tRestart('auto_restart_button'),
        })}
      </>
    ),
    readonly: t('field_tag_readonly'),
    envPrefix: t('field_tag_env_prefix'),
    todo: t('field_tag_todo'),
    shadowed: t('field_tag_shadowed'),
  };
}
