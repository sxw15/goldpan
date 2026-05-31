'use client';

import type { EnvKeyState, LlmProvidersResponse, ManagedEnvKey } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { Btn } from '@/components/ui/button';
import { SettingsField } from '@/components/ui/settings-field';
import { Toggle } from '@/components/ui/toggle';
import { rethrowNextErrors } from '@/lib/rethrow';
import { useEnvMappingVisible } from '../../env-mapping-visibility';
import type { LlmStepDef } from '../../llm-steps';
import { OriginBadge } from '../../settings-primitives';
import { useFieldTagLabels } from '../../use-field-tag-labels';
import { ReasoningAdvanced } from './reasoning-advanced';

/**
 * pendingProvider lives at the GroupLLM level (lifted state) instead of
 * inside each PipelineStepRow. Reason: the LLM page has Providers/Pipeline
 * tabs implemented as conditional render — switching to Providers unmounts
 * the entire pipeline panel, destroying every row's local state. A user
 * who picked a provider but hadn't picked a model yet would lose that
 * intermediate state when they popped over to Providers to add an API key.
 * The leave-guard wiring (setFieldEditing) is also lifted, so that
 * leave-guard registration survives the tab unmount.
 *
 * Each row remains the source of truth for its OWN reading/writing of the
 * pending value — receives `pendingProvider` as a prop, calls
 * `setPendingProvider(v)` to mutate. The release-on-env-catch-up effect
 * also moved here so the lifted state respects the canonical "we matched"
 * condition.
 */
export type PendingProviderProps = {
  pendingProvider: string | null;
  setPendingProvider: (v: string | null) => void;
};

interface ProviderOption {
  /** Stable id used as `<provider>:<model>` prefix and dropdown value. */
  id: string;
  /** Display label — same as id for now (provider names are short and stable). */
  label: string;
  /** When `false`, option is rendered but `disabled` with a hover hint
   * pointing at the secret row below. ollama is always `true` because the
   * backend treats empty `apiKeyEnv` as configured. */
  available: boolean;
}

interface Props extends PendingProviderProps {
  step: LlmStepDef;
  env: ReadonlyMap<string, EnvKeyState>;
  providers: LlmProvidersResponse | null;
  /** Per-field auto-commit driver (writes `{[envKey]: value}` to commitEnv).
   * Replaces the legacy `patch` + SaveBar path so model-picker / toggle
   * changes land on the server immediately. */
  commit: (
    patch: Record<string, string | null>,
  ) => Promise<import('@goldpan/web-sdk').CommitEnvResult>;
  resetEnvKey: (key: string) => Promise<boolean>;
  /** Set of env keys with an in-flight commit (mirrors GroupProps.inFlightKeys).
   * Used by the Reset button and the model-select to block clicks while a
   * sibling write is still mid-air, avoiding last-write-wins races. */
  inFlightKeys: ReadonlySet<string>;
}

/**
 * Build the dropdown option list, sorted alphabetically across all three
 * sections. Failed / skipped plugin providers are excluded — they literally
 * aren't callable. Builtin availability comes from `apiKeyConfigured` (ollama
 * 现在由 `GOLDPAN_OLLAMA_ENABLED` 显式开关控制 —— 关闭时 apiKeyConfigured=false
 * 在下拉里被 disabled，不再误导用户). Custom availability mirrors its own
 * apiKeyConfigured; plugin(loaded) is always available — its missing-key
 * concerns are surfaced via the failed status path which we filter out here.
 */
function buildOptions(providers: LlmProvidersResponse | null): ProviderOption[] {
  if (providers === null) return [];
  const out: ProviderOption[] = [];
  for (const b of providers.builtin) {
    out.push({ id: b.id, label: b.id, available: b.apiKeyConfigured });
  }
  for (const c of providers.custom) {
    out.push({ id: c.id, label: c.id, available: c.apiKeyConfigured });
  }
  for (const p of providers.plugin) {
    if (p.status === 'loaded') {
      out.push({ id: p.providerId, label: p.providerId, available: true });
    }
  }
  out.sort((a, z) => a.id.localeCompare(z.id));
  return out;
}

/**
 * 拿到选中 provider 的 model 列表 —— 全部来自 server 返回的 `provider.models`
 * （后端从统一的 `GOLDPAN_LLM_PROVIDER_<ID>_MODELS` env 解析）。前端**不**再
 * 维护硬编码 fallback：用户没在 Provider 页录入 model 列表的话，下拉为空、
 * 显示「请先在 Provider 配置里录入 model」提示，强制用户去 Provider 页补全。
 *
 * `?? []` 兜底是为了跨版本升级窗口（dist 已升级、server 还没重启）时不 crash UI。
 */
function getProviderModels(
  providers: LlmProvidersResponse | null,
  providerId: string,
): ReadonlyArray<string> {
  if (providers === null || providerId === '') return [];
  const builtin = providers.builtin.find((b) => b.id === providerId);
  if (builtin) return builtin.models ?? [];
  const custom = providers.custom.find((c) => c.id === providerId);
  if (custom) return custom.models ?? [];
  const plugin = providers.plugin.find((p) => p.providerId === providerId);
  if (plugin) return plugin.models ?? [];
  return [];
}

/** Read effective `<provider>:<model>` from env mask.
 *
 * 未显式配置时（source==='default'，mask='') 返回空 —— UI 由 placeholder option
 * 接管显示「未设置」。之前用 step.defaultProviderModel 兜底会显示 'openai:...'
 * 这种锁定外观，但用户可能根本没配 openai key，下拉里 openai 又是 disabled，
 * 看上去像 UI 卡死。空状态反而更诚实：让用户知道「这一行你没配过」。后端在
 * env / DB 都没值时仍走 zod default，这只是显示层的语义抽象。
 */
function readEffective(
  envKey: ManagedEnvKey,
  env: ReadonlyMap<string, EnvKeyState>,
): { provider: string; model: string } {
  const raw = env.get(envKey)?.mask ?? '';
  const idx = raw.indexOf(':');
  if (idx < 0) return { provider: raw, model: '' };
  return { provider: raw.slice(0, idx), model: raw.slice(idx + 1) };
}

export function PipelineStepRow({
  step,
  env,
  providers,
  commit,
  resetEnvKey,
  inFlightKeys,
  pendingProvider,
  setPendingProvider,
}: Props) {
  const tMatrix = useTranslations('settings.llm.matrix');
  const tStep = useTranslations(`settings.llm.steps.${step.id}`);
  const fieldTagLabels = useFieldTagLabels();
  const envMappingVisible = useEnvMappingVisible();

  const options = useMemo(() => buildOptions(providers), [providers]);
  const envEffective = readEffective(step.envKey, env);
  // "Provider picked but model not yet chosen" lives in lifted state at
  // GroupLLM (see PendingProviderProps above). Previous design committed
  // `${provider}:` (empty model) on every provider dropdown change —
  // modelIdSchema rejects that format outright (Must be providerId:modelId),
  // so every provider switch surfaced a red toast before the user even
  // reached the model dropdown. Keeping the pending provider lifted means
  // tab switches inside the LLM page (Providers ↔ Pipeline) preserve the
  // intermediate state instead of destroying it on unmount.
  //
  // Release-on-catch-up: as soon as env mask reflects the picked provider
  // (commit succeeded → env updated → derived provider matches), drop the
  // pending entry so we don't double-render. External resets / failed
  // commits leave pendingProvider in place until the user picks a model or
  // explicitly resets the row. The setPendingProvider closure was captured
  // by GroupLLM so the leave-guard wiring up there sees the change too.
  useEffect(() => {
    if (pendingProvider !== null && envEffective.provider === pendingProvider) {
      setPendingProvider(null);
    }
  }, [envEffective.provider, pendingProvider, setPendingProvider]);
  const effective = {
    provider: pendingProvider ?? envEffective.provider,
    // Model cell renders empty whenever provider is in "pending" mode so the
    // user sees they need to pick a model. Once env catches up, this falls
    // back to envEffective.model and the row settles.
    model: pendingProvider !== null ? '' : envEffective.model,
  };
  const providerModels = useMemo(
    () => getProviderModels(providers, effective.provider),
    [providers, effective.provider],
  );

  const [providerJustChanged, setProviderJustChanged] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resettingToggle, setResettingToggle] = useState(false);

  // Per-step timeout edits live in a separate collapsible section below the
  // model matrix, NOT inline on the row, to keep the busy provider/model
  // cells from getting crammed further. Row may still surface a tiny pill
  // when an override exists (rendered below) so users see at a glance which
  // step is offset from the global default. Editing happens in the panel.
  const timeoutState = env.get(step.timeoutEnvKey);
  const timeoutOverrideValue = timeoutState?.mask ?? '';
  const timeoutHasOverride = timeoutOverrideValue !== '' && timeoutState?.source === 'override';

  // effective.model 不在 known list 时（legacy 部署 / provider models 改过）渲染
  // 为 fallback option，让用户能看到当前值并主动重选 —— 不再退回「手动输入」。
  // providers === null (loading) 时不要标 off-list，等加载完再判。
  const offListModel =
    providers !== null &&
    effective.model !== '' &&
    providerModels.length > 0 &&
    !providerModels.includes(effective.model);

  const state = env.get(step.envKey);
  const enabledState = step.conditional ? env.get(step.conditional.enabledEnvKey) : undefined;
  const featureEnabled = !step.conditional || enabledState?.mask === 'true';

  const onProviderChange = (next: string) => {
    if (isCommittingKey) return;
    if (next === effective.provider) return;
    setProviderJustChanged(true);
    // Local-only — no commit until model is also picked. See pendingProvider
    // comment above for the schema-rejection rationale.
    setPendingProvider(next);
  };

  const onModelSelectChange = (next: string) => {
    if (isCommittingKey) return;
    if (effective.provider === '' || next === effective.model) return;
    setProviderJustChanged(false);
    // Capture the chosen provider so we can clear pendingProvider on
    // success even if `effective.provider` mutates between fire and
    // resolution. On rejection (kind:'errors' OR network) the server
    // didn't apply our pick, so we MUST keep pendingProvider set —
    // dropping it would erase the intermediate state and the row would
    // show the OLD provider with no warning that the user's pick failed.
    const pickedProvider = effective.provider;
    commit({ [step.envKey]: `${pickedProvider}:${next}` })
      .then((result) => {
        if (result.kind === 'ok') setPendingProvider(null);
        // kind:'errors' → shell toasted, keep pendingProvider for retry.
      })
      .catch(rethrowNextErrors);
  };

  const onResetClick = async () => {
    setResetting(true);
    try {
      await resetEnvKey(step.envKey);
      setProviderJustChanged(false);
      setPendingProvider(null);
    } finally {
      setResetting(false);
    }
  };
  // Block Reset while any in-flight commit on this key is unresolved —
  // racing reset+save → last-write-wins → the slower commit may write
  // back the just-reset value. mirrors llm-timeout-panel's behaviour.
  const isCommittingKey = inFlightKeys.has(step.envKey);

  // 未设置状态（provider/model 都空）走 placeholder option 表达，不再额外提示
  // 「填写不完整」—— 那个红字对初始未配置的行太聒噪。只在「选了 provider 但
  // 还没选 model」这种部分填写的中间态显示。
  const formatInvalid = effective.provider !== '' && effective.model === '';
  const showProviderChangedWarn = providerJustChanged && effective.model === '';

  // Disabled hint lives in the label's hint slot (under `step.hint`), NOT in
  // the value cell. The hint text is long and CJK has few break opportunities,
  // so when it lived inside `.gp-llm-step-row__pickers` it pushed the grid's
  // right column out to ~740px and squeezed the 1fr left column down to 0,
  // breaking the step label into a single-char vertical column. Putting it
  // under the label puts it in the 1fr column where it has room to wrap.
  const buildDisabledHintNode = () => {
    if (!step.conditional || step.conditional.inlineToggle) return null;
    if (featureEnabled) return null;
    let restartHint: string;
    if (step.conditional.enabledEnvKey === 'GOLDPAN_DIGEST_ENABLED') {
      restartHint = tMatrix('feature_disabled_hint_restart', {
        settingsPath: tMatrix('feature_disabled_link_digest'),
      });
    } else if (step.conditional.enabledEnvKey === 'GOLDPAN_TRANSLATE_PIPELINE_OUTPUT') {
      restartHint = tMatrix('feature_disabled_hint_enable_at', {
        settingsPath: tMatrix('feature_disabled_link_appearance'),
      });
    } else {
      restartHint = tMatrix('feature_disabled_hint_hot');
    }
    return (
      <span className="gp-llm-step-row__disabled-hint">
        {tMatrix('feature_disabled_hint', { feature: tStep('label'), restartHint })}
      </span>
    );
  };

  const disabledHintNode = buildDisabledHintNode();

  const renderInlineToggle = () => {
    if (!step.conditional?.inlineToggle) return null;
    const isOn = featureEnabled;
    const label =
      step.id === 'verifier'
        ? tMatrix('toggle_label_verifier')
        : step.id === 'translator'
          ? tMatrix('toggle_label_translator')
          : tMatrix('toggle_label_relator');
    // visible label 是简洁的「启用」/「Enable」,但同页有 3 个 conditional toggle
    // (verifier / relator / translator) 同名,屏幕阅读器读不出区分。aria-label
    // 拼上 step.id 让 AT 能识别这是哪一行的 toggle,同时保持视觉简洁。
    const ariaLabel = `${label} ${step.id}`;
    // Mirror isCommittingKey on the main step row: while a commit on the
    // conditional toggle's enabledEnvKey is mid-flight, disable both the
    // Toggle (prevent re-fire) and hide the Reset (which would race the
    // unresolved commit → last-write-wins). Previously only the main
    // step.envKey path had this guard — toggling verifier OFF then quickly
    // clicking Reset on the same row could land in either order.
    const toggleEnvKey = step.conditional.enabledEnvKey;
    const toggleInFlight = inFlightKeys.has(toggleEnvKey);
    const showToggleReset = enabledState?.source === 'override' && !toggleInFlight;
    return (
      <span className="gp-llm-step-row__toggle">
        <Toggle
          ariaLabel={ariaLabel}
          on={isOn}
          disabled={toggleInFlight}
          onChange={(v) => {
            if (step.conditional) {
              commit({ [step.conditional.enabledEnvKey]: v ? 'true' : 'false' }).catch(
                rethrowNextErrors,
              );
            }
          }}
        />
        <span>{label}</span>
        {enabledState?.source && envMappingVisible ? (
          <span className="gp-llm-step-row__toggle-origin">
            <OriginBadge
              source={enabledState.source}
              baselineDiffers={enabledState.baselineDiffers}
            />
          </span>
        ) : null}
        {showToggleReset ? (
          <Btn
            sm
            kind="ghost"
            disabled={resettingToggle}
            onClick={async () => {
              if (!step.conditional) return;
              setResettingToggle(true);
              try {
                await resetEnvKey(step.conditional.enabledEnvKey);
              } finally {
                setResettingToggle(false);
              }
            }}
          >
            {resettingToggle ? tMatrix('reset_in_progress_label') : tMatrix('reset_label')}
          </Btn>
        ) : null}
      </span>
    );
  };

  return (
    <div className="gp-llm-step-row-wrap">
      <SettingsField
        tagLabels={fieldTagLabels}
        label={tStep('label')}
        hint={
          disabledHintNode === null ? (
            tStep('hint')
          ) : (
            <>
              {tStep('hint')}
              <br />
              {disabledHintNode}
            </>
          )
        }
        env={step.envKey}
        source={state?.source}
        baselineDiffers={state?.baselineDiffers}
        shadowed={state?.source === 'override' && state?.baselineDiffers === true}
        onReset={state?.source === 'override' && !isCommittingKey ? onResetClick : undefined}
        resetting={resetting}
        resetLabel={tMatrix('reset_label')}
        resetInProgressLabel={tMatrix('reset_in_progress_label')}
        resetTitle={tMatrix('reset_title')}
        value={
          <span className="gp-llm-step-row__pickers">
            <select
              className="gp-sselect"
              aria-label={tMatrix('provider_select_aria', { step: tStep('label') })}
              value={effective.provider}
              disabled={isCommittingKey}
              onChange={(e) => onProviderChange(e.target.value)}
            >
              {effective.provider === '' ? (
                <option value="" disabled>
                  {tMatrix('provider_select_placeholder')}
                </option>
              ) : null}
              {options.map((o) => (
                <option
                  key={o.id}
                  value={o.id}
                  disabled={!o.available}
                  title={!o.available ? tMatrix('unconfigured_provider_hint') : undefined}
                >
                  {o.label}
                  {!o.available ? ` (${tMatrix('unconfigured_provider_hint')})` : ''}
                </option>
              ))}
              {effective.provider !== '' && !options.some((o) => o.id === effective.provider) ? (
                <option value={effective.provider}>{effective.provider} · ?</option>
              ) : null}
            </select>
            <select
              className="gp-sselect gp-sselect--mono"
              aria-label={tMatrix('model_input_aria', { step: tStep('label') })}
              value={effective.model === '' ? '' : effective.model}
              onChange={(e) => onModelSelectChange(e.target.value)}
              disabled={isCommittingKey || effective.provider === '' || providerModels.length === 0}
            >
              {effective.model === '' ? (
                <option value="" disabled>
                  {providerModels.length === 0 && effective.provider !== ''
                    ? tMatrix('model_no_models_configured')
                    : tMatrix('model_select_placeholder')}
                </option>
              ) : null}
              {providerModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {offListModel ? <option value={effective.model}>{effective.model} · ?</option> : null}
            </select>
            {timeoutHasOverride ? (
              <span
                className="gp-llm-step-row__timeout-pill"
                title={tMatrix('timeout_pill_title', { value: timeoutOverrideValue })}
              >
                {tMatrix('timeout_pill_label', { value: timeoutOverrideValue })}
              </span>
            ) : null}
            {showProviderChangedWarn ? (
              <span className="gp-llm-step-row__warn">{tMatrix('provider_changed_warn')}</span>
            ) : formatInvalid ? (
              <span className="gp-llm-step-row__warn">{tMatrix('format_invalid')}</span>
            ) : null}
          </span>
        }
        control={renderInlineToggle()}
      />
      {featureEnabled ? (
        <ReasoningAdvanced
          stepId={step.id}
          provider={effective.provider}
          env={env}
          commit={commit}
          resetEnvKey={resetEnvKey}
          // pendingProvider !== null means user picked provider but not
          // model — committing reasoning options now would write under
          // the unsaved provider's env key, orphaning the options if
          // the user later changes their mind. Lock the select.
          providerLocked={pendingProvider !== null}
        />
      ) : null}
    </div>
  );
}
