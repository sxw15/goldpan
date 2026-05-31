'use client';

import type { PluginSettingsContributionDescriptor } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { SettingsCard } from '@/components/ui/settings-card';
import { SettingsField } from '@/components/ui/settings-field';
import { SettingsHead } from '@/components/ui/settings-head';
import { Toggle } from '@/components/ui/toggle';
import { useEditableCommit, useToggleCommit } from '@/components/ui/use-field-commit';
import { PluginActionButton } from '../plugin-contribution-card';
import { SecretRow } from '../secret-row';
import { configErrorI18nKey } from '../settings-data';
import type { GroupProps } from '../settings-shell';
import { SetupGuide } from '../setup-guide';
import { useFieldTagLabels } from '../use-field-tag-labels';

export function GroupCollect(
  props: GroupProps & { contributions?: PluginSettingsContributionDescriptor[] },
) {
  const { env, resetEnvKey, commit, contributions, setFieldEditing } = props;
  const t = useTranslations('settings.collect');
  const tShell = useTranslations('settings.shell');
  const tagLabels = useFieldTagLabels();
  // contributions is undefined when the prop wasn't threaded through (older
  // tests, snapshot fixtures); treat missing as "no plugin extras to render"
  // rather than throwing on `.find()` of undefined.
  const githubContribution = contributions?.find((c) => c.pluginId === 'collector-github');

  const sharedDeps = { env, resetEnvKey, commit, setFieldEditing, tagLabels };

  // Content-length fields auto-commit per-field and surface errors INLINE via the
  // field hook, which carries only `message` (not `code`). Localize the cross-field
  // constraint error here by code before the hook renders it — otherwise the raw
  // English fallback leaks into the localized UI. The settings-shell toast localizes
  // the same codes through the shared `configErrorI18nKey` map.
  const contentLengthCommit: GroupProps['commit'] = async (patch) => {
    const result = await commit(patch);
    if (result.kind !== 'errors') return result;
    return {
      ...result,
      errors: result.errors.map((e) => {
        const key = configErrorI18nKey(e.code);
        return key ? { ...e, message: tShell(key) } : e;
      }),
    };
  };
  const contentLengthDeps = { ...sharedDeps, commit: contentLengthCommit };

  return (
    <>
      <SettingsHead crumb={t('crumb')} heading={t('heading')} desc={t('desc')} />

      <SettingsCard heading={t('card_global')}>
        <FieldNumber
          envKey="GOLDPAN_COLLECT_TIMEOUT"
          label={t('field_collect_timeout_label')}
          hint={t('field_collect_timeout_hint')}
          {...sharedDeps}
        />
      </SettingsCard>

      <SettingsCard heading={t('card_content_length')}>
        <FieldNumber
          envKey="GOLDPAN_MAX_CONTENT_LENGTH"
          label={t('field_max_content_label')}
          hint={t('field_max_content_hint')}
          hot
          {...contentLengthDeps}
        />
        <FieldNumber
          envKey="GOLDPAN_MIN_CONTENT_LENGTH"
          label={t('field_min_content_label')}
          hint={t('field_min_content_hint')}
          hot
          {...contentLengthDeps}
        />
        <FieldNumber
          envKey="GOLDPAN_MAX_TEXT_INPUT_LENGTH"
          label={t('field_max_text_input_label')}
          hint={t('field_max_text_input_hint')}
          hot
          {...contentLengthDeps}
        />
      </SettingsCard>

      <SettingsCard heading={t('card_browser')}>
        <FieldEnum
          envKey="GOLDPAN_BROWSER_STRATEGY"
          label={t('field_browser_strategy_label')}
          hint={t('field_browser_strategy_hint')}
          options={[
            { value: 'auto', labelKey: 'auto' },
            { value: 'bundled', labelKey: 'bundled' },
            { value: 'system-chrome', labelKey: 'system_chrome' },
          ]}
          {...sharedDeps}
          t={t}
        />
        <FieldText
          envKey="GOLDPAN_BROWSER_EXECUTABLE_PATH"
          label={t('field_browser_executable_label')}
          hint={t('field_browser_executable_hint')}
          {...sharedDeps}
        />
      </SettingsCard>

      <SettingsCard heading={t('card_media')}>
        <FieldNumber
          envKey="GOLDPAN_MEDIA_COLLECT_TIMEOUT"
          label={t('field_media_timeout_label')}
          hint={t('field_media_timeout_hint')}
          {...sharedDeps}
        />
        <FieldToggle
          envKey="GOLDPAN_YT_DLP_AUTO_UPDATE"
          label={t('field_yt_dlp_auto_update_label')}
          hint={t('field_yt_dlp_auto_update_hint')}
          {...sharedDeps}
        />
        <FieldText
          envKey="GOLDPAN_YT_DLP_BINARY_PATH"
          label={t('field_yt_dlp_binary_label')}
          hint={t('field_yt_dlp_binary_hint')}
          {...sharedDeps}
        />
        <FieldText
          envKey="GOLDPAN_YT_DLP_COOKIES_PATH"
          label={t('field_yt_dlp_cookies_label')}
          hint={t('field_yt_dlp_cookies_hint')}
          {...sharedDeps}
        />
      </SettingsCard>

      <SettingsCard heading={t('card_github')}>
        {githubContribution?.setupGuide !== undefined && (
          <SetupGuide
            pluginId={githubContribution.pluginId}
            guide={githubContribution.setupGuide}
          />
        )}
        <SecretRow
          label={t('field_github_token_label')}
          envKey="GOLDPAN_GITHUB_TOKEN"
          placeholder={t('placeholder_github_token')}
          group={props}
          i18nNamespace="settings.collect"
          restart="restart"
        />
        {githubContribution?.actions?.map((action) => (
          <PluginActionButton
            key={action.id}
            pluginId={githubContribution.pluginId}
            action={action}
            fields={githubContribution.fields}
            group={props}
          />
        ))}
      </SettingsCard>
    </>
  );
}

interface BaseFieldProps {
  envKey: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  env: GroupProps['env'];
  resetEnvKey: GroupProps['resetEnvKey'];
  commit: GroupProps['commit'];
  setFieldEditing: GroupProps['setFieldEditing'];
  tagLabels: ReturnType<typeof useFieldTagLabels>;
  /** Hot-reloadable field — suppresses the "改后需重启" tag. Most collect keys
   * are plugin-init values (restart-required, the default); content-length
   * limits are read per-task via `ctx.config`, so they take effect immediately.
   * Currently honored by FieldNumber only (the only helper with hot fields). */
  hot?: boolean;
}

// Shared "reset-with-hook-coordination" wrapper for the local field helpers
// below — each helper holds its own commit hook, so the reset button needs
// to call hook.clear() / hook.markError() to keep the inline FieldStatus
// truthful when the override is removed. Mirrors the account / embedding
// pattern verbatim so resets feel identical across groups.
function useResetCoordination(
  envKey: string,
  state: ReturnType<GroupProps['env']['get']>,
  hookState: string,
  resetEnvKey: GroupProps['resetEnvKey'],
  hookClear: () => void,
  hookMarkError: (m: string) => void,
  resetFailedInline: string,
) {
  const [resetting, setResetting] = useState(false);
  const eligible = state?.source === 'override' && hookState !== 'saving';
  const onReset = eligible
    ? async () => {
        setResetting(true);
        try {
          const ok = await resetEnvKey(envKey);
          if (ok) {
            hookClear();
          } else {
            hookMarkError(resetFailedInline);
          }
        } finally {
          setResetting(false);
        }
      }
    : undefined;
  return { resetting, onReset };
}

function FieldNumber(p: BaseFieldProps) {
  const state = p.env.get(p.envKey);
  const tActions = useTranslations('settings.actions');
  const hook = useEditableCommit({
    envKey: p.envKey,
    committed: state?.mask ?? '',
    commit: p.commit,
    fieldName: typeof p.label === 'string' ? p.label : undefined,
    baselineDiffers: state?.baselineDiffers,
    onEditingChange: (editing) => p.setFieldEditing(p.envKey, editing),
  });
  const { resetting, onReset } = useResetCoordination(
    p.envKey,
    state,
    hook.state,
    p.resetEnvKey,
    hook.clear,
    hook.markError,
    tActions('reset_failed_inline'),
  );
  return (
    <SettingsField
      label={p.label}
      hint={p.hint}
      env={p.envKey}
      restart={p.hot ? undefined : 'restart'}
      tagLabels={p.tagLabels}
      source={state?.source}
      baselineDiffers={state?.baselineDiffers}
      onReset={onReset}
      resetting={resetting}
      resetLabel={tActions('reset')}
      resetInProgressLabel={tActions('reset_in_progress')}
      resetTitle={tActions('reset_hint')}
      status={hook.status}
      control={
        <input
          type="number"
          value={hook.draft}
          aria-label={p.envKey.toLowerCase()}
          disabled={hook.state === 'saving'}
          onChange={(e) => hook.setDraft(e.target.value)}
          onBlur={() => {
            if (hook.dirty) void hook.save();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              // Don't blur after cancel — cancel()'s setDraft is enqueued, not
              // flushed; the synchronous blur handler would still see hook.dirty
              // from the previous render and call save(), turning Escape into Save.
              hook.cancel();
            }
          }}
        />
      }
    />
  );
}

function FieldText(p: BaseFieldProps) {
  const state = p.env.get(p.envKey);
  const tActions = useTranslations('settings.actions');
  const hook = useEditableCommit({
    envKey: p.envKey,
    committed: state?.mask ?? '',
    commit: p.commit,
    fieldName: typeof p.label === 'string' ? p.label : undefined,
    baselineDiffers: state?.baselineDiffers,
    onEditingChange: (editing) => p.setFieldEditing(p.envKey, editing),
  });
  const { resetting, onReset } = useResetCoordination(
    p.envKey,
    state,
    hook.state,
    p.resetEnvKey,
    hook.clear,
    hook.markError,
    tActions('reset_failed_inline'),
  );
  return (
    <SettingsField
      label={p.label}
      hint={p.hint}
      env={p.envKey}
      restart="restart"
      tagLabels={p.tagLabels}
      source={state?.source}
      baselineDiffers={state?.baselineDiffers}
      onReset={onReset}
      resetting={resetting}
      resetLabel={tActions('reset')}
      resetInProgressLabel={tActions('reset_in_progress')}
      resetTitle={tActions('reset_hint')}
      status={hook.status}
      control={
        <input
          type="text"
          value={hook.draft}
          aria-label={p.envKey.toLowerCase()}
          disabled={hook.state === 'saving'}
          onChange={(e) => hook.setDraft(e.target.value)}
          onBlur={() => {
            if (hook.dirty) void hook.save();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              hook.cancel();
            }
          }}
        />
      }
    />
  );
}

function FieldToggle(p: BaseFieldProps) {
  const state = p.env.get(p.envKey);
  const tActions = useTranslations('settings.actions');
  // Use `||` not `??`: unconfigured keys (`source: 'default'`) come back
  // as mask='' from the server (settings.ts `mask: ''` for non-secret
  // default keys), which is non-nullish, so `?? 'true'` would seed the
  // Toggle to '' and `on={hook.current === 'true'}` would resolve to
  // false on a fresh install even when the core schema default is 'true'.
  // YT_DLP_AUTO_UPDATE has schema default 'true' — fix preserves that.
  const hook = useToggleCommit({
    envKey: p.envKey,
    committed: state?.mask || 'true',
    commit: p.commit,
    fieldName: typeof p.label === 'string' ? p.label : undefined,
    baselineDiffers: state?.baselineDiffers,
  });
  const on = hook.current === 'true';
  const { resetting, onReset } = useResetCoordination(
    p.envKey,
    state,
    hook.state,
    p.resetEnvKey,
    hook.clear,
    hook.markError,
    tActions('reset_failed_inline'),
  );
  return (
    <SettingsField
      label={p.label}
      hint={p.hint}
      env={p.envKey}
      restart="restart"
      tagLabels={p.tagLabels}
      source={state?.source}
      baselineDiffers={state?.baselineDiffers}
      onReset={onReset}
      resetting={resetting}
      resetLabel={tActions('reset')}
      resetInProgressLabel={tActions('reset_in_progress')}
      resetTitle={tActions('reset_hint')}
      status={hook.status}
      control={
        <Toggle
          on={on}
          disabled={hook.state === 'saving'}
          onChange={(v) => {
            void hook.fire(v ? 'true' : 'false');
          }}
        />
      }
    />
  );
}

interface EnumFieldProps extends BaseFieldProps {
  options: { value: string; labelKey: string }[];
  t: (key: string) => string;
}

function FieldEnum(p: EnumFieldProps) {
  const state = p.env.get(p.envKey);
  const tActions = useTranslations('settings.actions');
  // Use `||` not `??`: unconfigured keys come back as mask='' (non-nullish),
  // so `?? options[0].value` would seed committed='' and the <select value>
  // would match no <option>. Callers list options with the schema default
  // first (BROWSER_STRATEGY: 'auto' first, schema default 'auto').
  const hook = useToggleCommit({
    envKey: p.envKey,
    committed: state?.mask || p.options[0].value,
    commit: p.commit,
    fieldName: typeof p.label === 'string' ? p.label : undefined,
    baselineDiffers: state?.baselineDiffers,
  });
  const { resetting, onReset } = useResetCoordination(
    p.envKey,
    state,
    hook.state,
    p.resetEnvKey,
    hook.clear,
    hook.markError,
    tActions('reset_failed_inline'),
  );
  return (
    <SettingsField
      label={p.label}
      hint={p.hint}
      env={p.envKey}
      restart="restart"
      tagLabels={p.tagLabels}
      source={state?.source}
      baselineDiffers={state?.baselineDiffers}
      onReset={onReset}
      resetting={resetting}
      resetLabel={tActions('reset')}
      resetInProgressLabel={tActions('reset_in_progress')}
      resetTitle={tActions('reset_hint')}
      status={hook.status}
      control={
        <select
          value={hook.current}
          aria-label={p.envKey.toLowerCase()}
          disabled={hook.state === 'saving'}
          onChange={(e) => {
            void hook.fire(e.target.value);
          }}
        >
          {p.options.map((o) => (
            <option key={o.value} value={o.value}>
              {p.t(`browser_strategy_${o.labelKey}`)}
            </option>
          ))}
        </select>
      }
    />
  );
}
