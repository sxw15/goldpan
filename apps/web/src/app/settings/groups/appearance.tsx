'use client';

import { formatTzLabel } from '@goldpan/core/lib/tz';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useTheme } from '@/components/theme-provider';
import { useTz } from '@/components/tz-provider';
import { Btn } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { SettingsCard } from '@/components/ui/settings-card';
import { SettingsField } from '@/components/ui/settings-field';
import { SettingsHead } from '@/components/ui/settings-head';
import { Toggle } from '@/components/ui/toggle';
import { useToggleCommit } from '@/components/ui/use-field-commit';
import type { Theme } from '@/lib/theme-cycle';
import type { GroupProps } from '../settings-shell';
import { useFieldTagLabels } from '../use-field-tag-labels';

export function GroupAppearance({ env, resetEnvKey, commit, mock, toast }: GroupProps) {
  const t = useTranslations('settings.appearance');
  const tShell = useTranslations('settings.shell');
  const tActions = useTranslations('settings.actions');
  const fieldTagLabels = useFieldTagLabels();
  const { theme, setTheme } = useTheme();
  const tz = useTz();
  // Reset progress is tracked independently from the commit hook — the hook
  // owns its own saving/saved indicator, but the reset button is a sibling
  // action that bypasses the hook (calls resetEnvKey on the shell directly).
  // After a successful reset we call `clear()` on the hook so the field's
  // FieldStatus row drops any "Saved · restart" left over from a prior commit.
  const [resettingLang, setResettingLang] = useState(false);
  const [resettingTranslate, setResettingTranslate] = useState(false);

  const langState = env.get('GOLDPAN_LANGUAGE');
  // Use `||` not `??`: unconfigured keys come back as mask='' (non-nullish),
  // so `?? 'en'` would seed committed='' and the <select value> would match
  // no <option>. `||` falls back on empty-string too. Default MUST match
  // core schema (`GOLDPAN_LANGUAGE.default('en')` in packages/core/src/config/index.ts)
  // — seeding 'zh' here on a fresh install made the UI show 中文 while the
  // server was actually running in English, a silent display/runtime drift.
  const langCommit = useToggleCommit({
    envKey: 'GOLDPAN_LANGUAGE',
    committed: langState?.mask || 'en',
    commit,
    fieldName: t('field_language_label'),
    baselineDiffers: langState?.baselineDiffers,
  });
  type Lang = 'zh' | 'en';
  const langCurrent = langCommit.current as Lang;

  const translateEnvKey = 'GOLDPAN_TRANSLATE_PIPELINE_OUTPUT';
  const translateState = env.get(translateEnvKey);
  const translateCommit = useToggleCommit({
    envKey: translateEnvKey,
    committed: translateState?.mask || 'false',
    commit,
    fieldName: t('field_translate_pipeline_label'),
    baselineDiffers: translateState?.baselineDiffers,
  });
  const translateOn = translateCommit.current === 'true';

  const onResetTranslate =
    translateState?.source === 'override' && translateCommit.state !== 'saving'
      ? async () => {
          setResettingTranslate(true);
          try {
            const ok = await resetEnvKey(translateEnvKey);
            if (ok) {
              translateCommit.clear();
            } else {
              translateCommit.markError(tActions('reset_failed_inline'));
            }
          } finally {
            setResettingTranslate(false);
          }
        }
      : undefined;

  const onResetLang =
    langState?.source === 'override' && langCommit.state !== 'saving'
      ? async () => {
          setResettingLang(true);
          try {
            const ok = await resetEnvKey('GOLDPAN_LANGUAGE');
            if (ok) {
              langCommit.clear();
            } else {
              langCommit.markError(tActions('reset_failed_inline'));
            }
          } finally {
            setResettingLang(false);
          }
        }
      : undefined;

  const THEME_LABELS: Record<Theme, string> = {
    light: t('theme_light'),
    dark: t('theme_dark'),
    system: t('theme_system'),
  };
  const LANG_LABELS: Record<Lang, string> = {
    zh: t('lang_zh'),
    en: t('lang_en'),
  };

  const DENSITY_LABELS: Record<'compact' | 'regular' | 'comfy', string> = {
    compact: t('density_compact'),
    regular: t('density_regular'),
    comfy: t('density_comfy'),
  };

  return (
    <>
      <SettingsHead crumb={t('crumb')} heading={t('heading')} desc={t('desc')} />
      <SettingsCard heading={t('card_appearance')}>
        <SettingsField
          tagLabels={fieldTagLabels}
          label={t('field_theme_label')}
          value={THEME_LABELS[theme]}
          control={
            <Segmented
              value={theme}
              options={[
                { value: 'light', label: t('theme_light') },
                { value: 'dark', label: t('theme_dark') },
                { value: 'system', label: t('theme_system') },
              ]}
              onChange={(v) => {
                setTheme(v as Theme);
                toast({ msg: t('theme_changed'), kind: 'success' });
              }}
            />
          }
        />
        <SettingsField
          tagLabels={fieldTagLabels}
          label={t('field_language_label')}
          env="GOLDPAN_LANGUAGE"
          restart="restart"
          source={langState?.source}
          baselineDiffers={langState?.baselineDiffers}
          onReset={onResetLang}
          resetting={resettingLang}
          resetLabel={tActions('reset')}
          resetInProgressLabel={tActions('reset_in_progress')}
          resetTitle={tActions('reset_hint')}
          shadowed={langState?.source === 'override' && langState?.baselineDiffers === true}
          status={langCommit.status}
          value={LANG_LABELS[langCurrent] ?? langCurrent}
          control={
            <select
              className="gp-sselect"
              value={langCurrent}
              disabled={langCommit.state === 'saving'}
              onChange={(e) => {
                void langCommit.fire(e.target.value);
              }}
            >
              <option value="zh">{t('lang_zh')}</option>
              <option value="en">{t('lang_en')}</option>
            </select>
          }
        />
        <SettingsField
          tagLabels={fieldTagLabels}
          label={t('field_translate_pipeline_label')}
          env={translateEnvKey}
          hint={t('field_translate_pipeline_hint')}
          source={translateState?.source}
          baselineDiffers={translateState?.baselineDiffers}
          onReset={onResetTranslate}
          resetting={resettingTranslate}
          resetLabel={tActions('reset')}
          resetInProgressLabel={tActions('reset_in_progress')}
          resetTitle={tActions('reset_hint')}
          shadowed={
            translateState?.source === 'override' && translateState?.baselineDiffers === true
          }
          status={translateCommit.status}
          value={translateOn ? t('translate_pipeline_on') : t('translate_pipeline_off')}
          control={
            <Toggle
              on={translateOn}
              disabled={translateCommit.state === 'saving'}
              onChange={(v) => {
                void translateCommit.fire(v ? 'true' : 'false');
              }}
            />
          }
        />
        <SettingsField
          tagLabels={fieldTagLabels}
          label={t('field_timezone_label')}
          hint={t('field_timezone_hint')}
          value={formatTzLabel(tz)}
          control={
            <Btn sm disabled title={t('field_timezone_env_only_tooltip')}>
              {t('timezone_change_button')}
            </Btn>
          }
        />
        <SettingsField
          tagLabels={fieldTagLabels}
          label={t('field_density_label')}
          todo
          value={DENSITY_LABELS[mock.appearance.density]}
          control={
            <Segmented
              value={mock.appearance.density}
              options={[
                { value: 'compact', label: t('density_compact') },
                { value: 'regular', label: t('density_regular') },
                { value: 'comfy', label: t('density_comfy') },
              ]}
              onChange={() => toast({ msg: tShell('unimplemented') })}
            />
          }
        />
      </SettingsCard>
    </>
  );
}
