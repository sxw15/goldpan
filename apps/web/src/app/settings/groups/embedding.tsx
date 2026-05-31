'use client';

import type { LlmProvidersResponse } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Notice } from '@/components/ui/notice';
import { SettingsCard } from '@/components/ui/settings-card';
import { SettingsField } from '@/components/ui/settings-field';
import { SettingsHead } from '@/components/ui/settings-head';
import { Toggle } from '@/components/ui/toggle';
import { useEditableCommit, useToggleCommit } from '@/components/ui/use-field-commit';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import { rethrowNextErrors } from '@/lib/rethrow';
import type { GroupProps } from '../settings-shell';
import { useFieldTagLabels } from '../use-field-tag-labels';

type ProviderOption = { id: string; available: boolean };

function buildProviderOptions(providers: LlmProvidersResponse | null): ProviderOption[] {
  if (providers === null) return [];
  const out: ProviderOption[] = [];
  for (const b of providers.builtin) out.push({ id: b.id, available: b.apiKeyConfigured });
  for (const c of providers.custom) out.push({ id: c.id, available: c.apiKeyConfigured });
  for (const p of providers.plugin) {
    if (p.status === 'loaded') out.push({ id: p.providerId, available: true });
  }
  out.sort((a, z) => a.id.localeCompare(z.id));
  return out;
}

function getProviderEmbeddingModels(
  providers: LlmProvidersResponse | null,
  providerId: string,
): ReadonlyArray<string> {
  if (providers === null || providerId === '') return [];
  // Embedding 设置只读 `embeddingModels`(来自 `_EMBEDDING_MODELS` env)，不读
  // chat models —— `gpt-4o` 这种 chat-only model 不能跑 embedding。
  const builtin = providers.builtin.find((b) => b.id === providerId);
  if (builtin) return builtin.embeddingModels ?? [];
  const custom = providers.custom.find((c) => c.id === providerId);
  if (custom) return custom.embeddingModels ?? [];
  const plugin = providers.plugin.find((p) => p.providerId === providerId);
  if (plugin) return plugin.embeddingModels ?? [];
  return [];
}

function decompose(modelId: string): { provider: string; model: string } {
  const idx = modelId.indexOf(':');
  if (idx < 0) return { provider: modelId, model: '' };
  return { provider: modelId.slice(0, idx), model: modelId.slice(idx + 1) };
}

export function GroupEmbedding({
  env,
  resetEnvKey,
  commit,
  inFlightKeys,
  setFieldEditing,
}: GroupProps) {
  const t = useTranslations('settings.embedding');
  const tActions = useTranslations('settings.actions');
  const fieldTagLabels = useFieldTagLabels();

  const [providers, setProviders] = useState<LlmProvidersResponse | null>(null);
  const loadProviders = useCallback(() => {
    getBrowserApiClient()
      .getLlmProviders()
      .then(setProviders)
      .catch(() => setProviders({ builtin: [], custom: [], plugin: [] }));
  }, []);

  useEffect(() => {
    void env.size;
    loadProviders();
  }, [env, loadProviders]);

  const enabledState = env.get('GOLDPAN_EMBEDDING_ENABLED');
  // Use `||` not `??`: server returns mask='' for unconfigured keys
  // (source='default'), and '' is non-nullish so `?? 'false'` would NOT
  // fall back, leaving the toggle bound to '' (neither 'true' nor 'false').
  // Same pattern applied to every committed-seed below.
  const enabledCommit = useToggleCommit({
    envKey: 'GOLDPAN_EMBEDDING_ENABLED',
    committed: enabledState?.mask || 'false',
    commit,
    fieldName: t('field_enabled_label'),
    baselineDiffers: enabledState?.baselineDiffers,
  });
  const enabled = enabledCommit.current === 'true';

  const modelState = env.get('GOLDPAN_EMBEDDING_MODEL');
  // Model is a composite "provider:model" string — useToggleCommit's
  // optimistic `current` carries the full committed-or-pending value so the
  // dropdowns stay in sync while a fire is in flight.
  const modelCommit = useToggleCommit({
    envKey: 'GOLDPAN_EMBEDDING_MODEL',
    committed: modelState?.mask || 'openai:text-embedding-3-small',
    commit,
    fieldName: t('field_model_label'),
    baselineDiffers: modelState?.baselineDiffers,
  });
  const committedEffective = decompose(modelCommit.current);
  // "Provider picked but model not yet chosen" stays local; do NOT fire
  // modelCommit with `${provider}:` — modelIdSchema rejects empty model
  // (Must be providerId:modelId), so each provider switch otherwise
  // round-trips a 400 and rolls back the optimistic value. Once the user
  // picks a model we fire `${provider}:${model}` once. pendingProvider
  // releases on next commit success via the useEffect below.
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  useEffect(() => {
    if (pendingProvider !== null && committedEffective.provider === pendingProvider) {
      setPendingProvider(null);
    }
  }, [committedEffective.provider, pendingProvider]);
  // Embedding switched OFF and the server confirmed it: drop any
  // pendingProvider so the leave-guard doesn't keep reporting "editing"
  // for a feature that's been deliberately disabled. Without this, a
  // user who picked a provider then disabled Embedding would leave with
  // a phantom editingFields entry (no visible control to address it).
  //
  // CRITICALLY: we gate on `enabledState?.mask === 'false'` (the
  // authoritative server value), NOT on the derived `enabled` boolean.
  // `enabled` comes from `enabledCommit.current`, which flips
  // optimistically the moment the user clicks Toggle. If the disable
  // commit then fails and rolls back, `enabled` flips back to true and
  // the model card re-mounts — but if we had cleared pendingProvider on
  // the optimistic flip, the user's provider pick is gone with no way
  // to recover. Waiting for the mask to actually be 'false' (commit
  // succeeded server-side) preserves the pick across the failed-disable
  // rollback path while still releasing it on a successful disable.
  useEffect(() => {
    if (enabledState?.mask === 'false' && pendingProvider !== null) {
      setPendingProvider(null);
    }
  }, [enabledState?.mask, pendingProvider]);
  // Wire pendingProvider into the shell's leave-guard — picking a provider
  // and navigating away without picking a model would otherwise silently
  // drop the intermediate state. Mirror the pipeline-step-row treatment.
  useEffect(() => {
    setFieldEditing('GOLDPAN_EMBEDDING_MODEL', pendingProvider !== null);
    return () => setFieldEditing('GOLDPAN_EMBEDDING_MODEL', false);
  }, [pendingProvider, setFieldEditing]);
  const effective = {
    provider: pendingProvider ?? committedEffective.provider,
    model: pendingProvider !== null ? '' : committedEffective.model,
  };

  const providerOptions = useMemo(() => buildProviderOptions(providers), [providers]);
  const providerModels = useMemo(
    () => getProviderEmbeddingModels(providers, effective.provider),
    [providers, effective.provider],
  );
  // 选中 provider 的 model 不在 known list 时，仍渲染为 fallback option，
  // 让用户能看到当前值并主动重选 —— 不接受手输。
  const offListModel =
    providers !== null &&
    effective.model !== '' &&
    providerModels.length > 0 &&
    !providerModels.includes(effective.model);
  const formatInvalid = effective.provider === '' || effective.model === '';

  const dimsState = env.get('GOLDPAN_EMBEDDING_DIMENSIONS');
  const dimsCommit = useEditableCommit({
    envKey: 'GOLDPAN_EMBEDDING_DIMENSIONS',
    committed: dimsState?.mask || '0',
    commit,
    fieldName: t('field_dimensions_label'),
    baselineDiffers: dimsState?.baselineDiffers,
    onEditingChange: (editing) => setFieldEditing('GOLDPAN_EMBEDDING_DIMENSIONS', editing),
  });

  const batchState = env.get('GOLDPAN_EMBEDDING_BATCH_SIZE');
  const batchCommit = useEditableCommit({
    envKey: 'GOLDPAN_EMBEDDING_BATCH_SIZE',
    committed: batchState?.mask || '100',
    commit,
    fieldName: t('field_batch_size_label'),
    baselineDiffers: batchState?.baselineDiffers,
    onEditingChange: (editing) => setFieldEditing('GOLDPAN_EMBEDDING_BATCH_SIZE', editing),
  });

  const [resettingKey, setResettingKey] = useState<string | null>(null);
  // Map each env key to its commit hook so the reset-button handler can call
  // hook.clear() / hook.markError() in one place, matching the account.tsx
  // pattern (success → clear, failure → markError so the inline FieldStatus
  // stops claiming "Saved · restart" for a server still holding the override).
  const hookByKey: Record<
    string,
    { clear: () => void; markError: (m: string) => void; state: string }
  > = {
    GOLDPAN_EMBEDDING_ENABLED: enabledCommit,
    GOLDPAN_EMBEDDING_MODEL: modelCommit,
    GOLDPAN_EMBEDDING_DIMENSIONS: dimsCommit,
    GOLDPAN_EMBEDDING_BATCH_SIZE: batchCommit,
  };
  const makeReset = (envKey: keyof typeof hookByKey) => async () => {
    setResettingKey(envKey);
    try {
      const ok = await resetEnvKey(envKey);
      if (ok) {
        hookByKey[envKey].clear();
        // EMBEDDING_MODEL specifically: also clear pendingProvider so a
        // user who picked a provider then changed their mind and clicked
        // Reset doesn't keep the row showing the abandoned local state.
        if (envKey === 'GOLDPAN_EMBEDDING_MODEL') setPendingProvider(null);
      } else {
        hookByKey[envKey].markError(tActions('reset_failed_inline'));
      }
    } finally {
      setResettingKey(null);
    }
  };
  const resetButtonProps = (
    envKey:
      | 'GOLDPAN_EMBEDDING_ENABLED'
      | 'GOLDPAN_EMBEDDING_MODEL'
      | 'GOLDPAN_EMBEDDING_DIMENSIONS'
      | 'GOLDPAN_EMBEDDING_BATCH_SIZE',
  ) => {
    const state = env.get(envKey);
    if (state?.source !== 'override') return {};
    // hook.state === 'saving' covers commits initiated by THIS hook;
    // inFlightKeys.has covers sibling writes (e.g. a plugin programmatically
    // committing the same key). Reset clicking while either is mid-air
    // would last-write-wins back to the just-reset value.
    if (hookByKey[envKey].state === 'saving' || inFlightKeys.has(envKey)) return {};
    return {
      onReset: makeReset(envKey),
      resetting: resettingKey === envKey,
      resetLabel: tActions('reset'),
      resetInProgressLabel: tActions('reset_in_progress'),
      resetTitle: tActions('reset_hint'),
    };
  };

  const onProviderChange = (next: string) => {
    if (next === effective.provider) return;
    setPendingProvider(next);
  };
  const onModelChange = (next: string) => {
    if (effective.provider === '' || next === effective.model) return;
    // Track the picked provider through the fire so a stale `effective`
    // identity doesn't matter — and on commit error keep pendingProvider
    // visible so the user knows their pick didn't land.
    const pickedProvider = effective.provider;
    modelCommit
      .fire(`${pickedProvider}:${next}`)
      .then((outcome) => {
        if (outcome.kind === 'saved' || outcome.kind === 'pending-restart') {
          setPendingProvider(null);
        }
        // error / superseded → keep pendingProvider so the row reflects the
        // unsaved intent rather than snapping back to old env.
      })
      // useToggleCommit.fire's internal catch calls rethrowNextErrors then
      // re-throws, so a 401 session-expiry NEXT_REDIRECT comes back via
      // promise rejection. Without this .catch the rejection is unhandled
      // and Next 16's client-side /login redirect never fires — user is
      // stranded on settings. Mirrors pipeline-step-row.tsx:219.
      .catch(rethrowNextErrors);
  };
  // Surface inFlightKeys via the shell so a sibling write to the same key
  // (e.g. plugin-driven commit) is gated alongside modelCommit.state. We
  // OR them into a single isSavingModel flag wired into the dropdowns and
  // Reset below — previous attempt to capture inFlightKeys here was dead
  // code (declared but never read), giving a false sense of protection.
  const isSavingModel =
    modelCommit.state === 'saving' || inFlightKeys.has('GOLDPAN_EMBEDDING_MODEL');

  return (
    <>
      <SettingsHead crumb={t('crumb')} heading={t('heading')} desc={t('desc')} />

      <SettingsCard heading={t('card_enable_heading')} sub={t('card_enable_sub')}>
        <SettingsField
          tagLabels={fieldTagLabels}
          label={t('field_enabled_label')}
          hint={t('field_enabled_hint')}
          env="GOLDPAN_EMBEDDING_ENABLED"
          restart="restart"
          source={enabledState?.source}
          baselineDiffers={enabledState?.baselineDiffers}
          shadowed={enabledState?.source === 'override' && enabledState?.baselineDiffers === true}
          status={enabledCommit.status}
          {...resetButtonProps('GOLDPAN_EMBEDDING_ENABLED')}
          value={enabled ? t('on_label') : t('off_label')}
          control={
            <Toggle
              on={enabled}
              disabled={enabledCommit.state === 'saving'}
              onChange={(v) => {
                void enabledCommit.fire(v ? 'true' : 'false');
              }}
            />
          }
        />
      </SettingsCard>

      {enabled ? (
        <>
          {modelState?.source !== 'override' &&
          (modelState === undefined || modelState.source === 'default') ? (
            <Notice kind="info">{t('first_time_hint')}</Notice>
          ) : null}
          <SettingsCard heading={t('card_model_heading')} sub={t('card_model_sub')}>
            <SettingsField
              tagLabels={fieldTagLabels}
              label={t('field_model_label')}
              hint={t('field_model_hint')}
              env="GOLDPAN_EMBEDDING_MODEL"
              restart="restart"
              source={modelState?.source}
              baselineDiffers={modelState?.baselineDiffers}
              shadowed={modelState?.source === 'override' && modelState?.baselineDiffers === true}
              status={modelCommit.status}
              {...resetButtonProps('GOLDPAN_EMBEDDING_MODEL')}
              value={
                <span className="gp-llm-step-row__pickers">
                  <select
                    className="gp-sselect"
                    aria-label={t('provider_select_aria')}
                    value={effective.provider}
                    disabled={isSavingModel}
                    onChange={(e) => onProviderChange(e.target.value)}
                  >
                    <option value="" disabled>
                      {t('provider_select_placeholder')}
                    </option>
                    {providerOptions.map((o) => (
                      <option
                        key={o.id}
                        value={o.id}
                        disabled={!o.available}
                        title={!o.available ? t('unconfigured_provider_hint') : undefined}
                      >
                        {o.id}
                        {!o.available ? ` (${t('unconfigured_provider_hint')})` : ''}
                      </option>
                    ))}
                    {effective.provider !== '' &&
                    !providerOptions.some((o) => o.id === effective.provider) ? (
                      <option value={effective.provider}>{effective.provider} · ?</option>
                    ) : null}
                  </select>
                  <select
                    className="gp-sselect gp-sselect--mono"
                    aria-label={t('model_select_aria')}
                    value={effective.model}
                    onChange={(e) => onModelChange(e.target.value)}
                    disabled={
                      effective.provider === '' || providerModels.length === 0 || isSavingModel
                    }
                  >
                    {effective.model === '' ? (
                      <option value="" disabled>
                        {providerModels.length === 0 && effective.provider !== ''
                          ? t('model_no_models_configured')
                          : t('model_select_placeholder')}
                      </option>
                    ) : null}
                    {providerModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    {offListModel ? (
                      <option value={effective.model}>{effective.model} · ?</option>
                    ) : null}
                  </select>
                  {formatInvalid ? (
                    <span className="gp-llm-step-row__warn">{t('format_invalid')}</span>
                  ) : null}
                </span>
              }
            />
            <SettingsField
              tagLabels={fieldTagLabels}
              label={t('field_dimensions_label')}
              hint={t('field_dimensions_hint')}
              env="GOLDPAN_EMBEDDING_DIMENSIONS"
              restart="restart"
              source={dimsState?.source}
              baselineDiffers={dimsState?.baselineDiffers}
              status={dimsCommit.status}
              {...resetButtonProps('GOLDPAN_EMBEDDING_DIMENSIONS')}
              control={
                <input
                  type="number"
                  className="gp-sinput gp-sinput--mono"
                  min={0}
                  value={dimsCommit.draft}
                  disabled={dimsCommit.state === 'saving'}
                  onChange={(e) => dimsCommit.setDraft(e.target.value)}
                  onBlur={() => {
                    if (dimsCommit.dirty) void dimsCommit.save();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    } else if (e.key === 'Escape') {
                      // No blur — see collect.tsx FieldNumber for race rationale.
                      dimsCommit.cancel();
                    }
                  }}
                />
              }
            />
            <SettingsField
              tagLabels={fieldTagLabels}
              label={t('field_batch_size_label')}
              hint={t('field_batch_size_hint')}
              env="GOLDPAN_EMBEDDING_BATCH_SIZE"
              restart="restart"
              source={batchState?.source}
              baselineDiffers={batchState?.baselineDiffers}
              status={batchCommit.status}
              {...resetButtonProps('GOLDPAN_EMBEDDING_BATCH_SIZE')}
              control={
                <input
                  type="number"
                  className="gp-sinput gp-sinput--mono"
                  min={1}
                  max={1000}
                  value={batchCommit.draft}
                  disabled={batchCommit.state === 'saving'}
                  onChange={(e) => batchCommit.setDraft(e.target.value)}
                  onBlur={() => {
                    if (batchCommit.dirty) void batchCommit.save();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    } else if (e.key === 'Escape') {
                      batchCommit.cancel();
                    }
                  }}
                />
              }
            />
          </SettingsCard>
        </>
      ) : null}
    </>
  );
}
