// apps/web/src/app/onboarding/_components/step-card.tsx
//
// One row in the F2 Pipeline page — title + description + optional toggle +
// two-stage model selector (provider select → model select) matching the
// settings page «LLM Pipeline» row.
//
// Selection flow (mirrors `apps/web/src/app/settings/groups/_components/
// pipeline-step-row.tsx`):
//   1. The provider `<select>` only lists providers the user has already
//      configured — builtin providers configured via the «Add Provider» card
//      above + custom/plugin providers self-configured outside the wizard
//      (`availableProviders`). Single entry point for adding a provider keeps
//      the mental model clean: configure once in the «Configured providers»
//      card, then pick from the dropdown here.
//   2. The model `<select>` lists `state.providers[provider].models` for
//      wizard-managed providers, or server-discovered `availableProviders`
//      models for external custom/plugin providers. Empty list → select
//      disabled; the user must add models before the step becomes valid.
//
// "Reuse previous step model" hint: rendered only when there IS a previous
// step model AND it differs from the current cfg.model — otherwise the hint
// would be visual noise, since clicking it would change nothing.
'use client';

import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { Btn } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { BUILTIN_PROVIDER_IDS } from './builtin-provider-defaults';
import { useWizard } from './wizard-state';

const KNOWN_LABEL_IDS = new Set<string>(BUILTIN_PROVIDER_IDS);

function providerLabel(id: string, tp: (key: string) => string): string {
  return KNOWN_LABEL_IDS.has(id) ? tp(`${id}_label`) : id;
}

type StepTitleKey =
  | 'steps.classifier.title'
  | 'steps.extractor.title'
  | 'steps.matcher.title'
  | 'steps.comparator.title'
  | 'steps.verifier.title'
  | 'steps.relator.title'
  | 'steps.intent.title'
  | 'steps.query.title';
type StepDescKey =
  | 'steps.classifier.description'
  | 'steps.extractor.description'
  | 'steps.matcher.description'
  | 'steps.comparator.description'
  | 'steps.verifier.description'
  | 'steps.relator.description'
  | 'steps.intent.description'
  | 'steps.query.description';

interface Props {
  stepKey: string;
  optional?: boolean;
  previousStepHint?: { step: string; model: string };
  /**
   * Position of this step within its section (1-based). Rendered before the
   * title as «N/total» so users can map a card back to a pipeline step
   * without counting downward. Both `index` and `total` are required to render
   * the badge — pass neither to omit it.
   */
  index?: number;
  total?: number;
}

interface ProviderOption {
  id: string;
  source: 'builtin' | 'custom' | 'plugin';
}

export function StepCard({ stepKey, optional, previousStepHint, index, total }: Props) {
  const t = useTranslations('onboarding');
  const tp = useTranslations('onboarding.providers');
  const { state, patch, availableProviders } = useWizard();
  const cfg = state.steps[stepKey] ?? {};

  // Provider options come from two sources:
  //   1. `state.providers` — both wizard-configured builtins (openai, ...)
  //      AND wizard-added custom OpenAI-compat providers. We treat any id NOT
  //      in BUILTIN_PROVIDER_IDS as `source: 'custom'`. Single source for
  //      anything the user has configured in this wizard session.
  //   2. `availableProviders` — server-reported custom (.env) / plugin
  //      providers that exist outside the wizard. Skipped if a wizard entry
  //      already claims the id (wizard takes priority).
  // Builtins the user hasn't configured yet are intentionally absent — the
  // user adds them via the «Add Provider» card above, then they show up here.
  const builtinIdSet = useMemo(() => new Set<string>(BUILTIN_PROVIDER_IDS), []);
  const providerOptions: ProviderOption[] = useMemo(() => {
    const map = new Map<string, ProviderOption>();
    for (const [id, cfg] of Object.entries(state.providers)) {
      if (!cfg?.apiKey && !cfg?.baseUrl) continue;
      const source: 'builtin' | 'custom' = builtinIdSet.has(id) ? 'builtin' : 'custom';
      map.set(id, { id, source });
    }
    for (const ap of availableProviders) {
      if (ap.source === 'builtin') continue;
      if (map.has(ap.id)) continue;
      map.set(ap.id, { id: ap.id, source: ap.source });
    }
    return Array.from(map.values());
  }, [state.providers, availableProviders, builtinIdSet]);

  // Optional steps default to disabled (verifier / relator). Required steps
  // are always considered enabled — the toggle isn't even rendered.
  const enabled = optional ? cfg.enabled === true : true;

  // Decompose `cfg.model` (`provider:model`) into parts.
  const colonIdx = cfg.model?.indexOf(':') ?? -1;
  const effectiveProvider = colonIdx >= 0 && cfg.model ? cfg.model.slice(0, colonIdx) : '';
  const effectiveModel = colonIdx >= 0 && cfg.model ? cfg.model.slice(colonIdx + 1) : '';

  const providerModels =
    state.providers[effectiveProvider]?.models ??
    availableProviders.find((p) => p.id === effectiveProvider)?.models ??
    [];
  // 选中 provider 的 model 不在 known list 时（legacy 状态 / provider models 已被
  // 用户改过），仍然渲染为 fallback option，让用户能看到当前值并主动重选 ——
  // 不再退回「手动输入」模式。
  const offListModel = effectiveModel !== '' && !providerModels.includes(effectiveModel);

  function selectProvider(providerId: string): void {
    if (providerId === effectiveProvider) return;
    // Auto-pick first model so the row is immediately valid; provider 有 model
    // 清单时直接落到第一项，否则留空让 user 在 Provider 配置里补 model。
    const nextModels =
      state.providers[providerId]?.models ??
      availableProviders.find((p) => p.id === providerId)?.models ??
      [];
    const nextModel = nextModels[0] ?? '';
    void patch({
      steps: {
        [stepKey]: { model: nextModel === '' ? `${providerId}:` : `${providerId}:${nextModel}` },
      },
    });
  }

  function selectModel(modelId: string): void {
    if (effectiveProvider === '') return;
    void patch({
      steps: { ...state.steps, [stepKey]: { ...cfg, model: `${effectiveProvider}:${modelId}` } },
    });
  }

  function reuseFullModelId(modelId: string): void {
    const idx = modelId.indexOf(':');
    if (idx < 0) return;
    const providerId = modelId.slice(0, idx);
    if (!state.providers[providerId] && !availableProviders.some((p) => p.id === providerId)) {
      return;
    }
    void patch({
      steps: { ...state.steps, [stepKey]: { ...cfg, model: modelId } },
    });
  }

  return (
    <div className="gp-step-card" data-state={enabled ? 'on' : 'off'}>
      <div className="gp-step-card__head">
        <div className="gp-step-card__heading">
          <h3 className="gp-step-card__title">
            {index !== undefined && total !== undefined ? (
              <span className="gp-step-card__index" aria-hidden="true">
                {index}/{total}
              </span>
            ) : null}
            {t(`steps.${stepKey}.title` as StepTitleKey)}
          </h3>
          <p className="gp-step-card__desc">{t(`steps.${stepKey}.description` as StepDescKey)}</p>
        </div>
        {optional && (
          <div className="gp-step-card__toggle">
            <span className="gp-step-card__toggle-label">{t('enable_optional_step')}</span>
            <Toggle
              on={enabled}
              onChange={(on) =>
                void patch({
                  steps: { ...state.steps, [stepKey]: { ...cfg, enabled: on } },
                })
              }
            />
          </div>
        )}
      </div>

      {enabled && (
        <div className="gp-step-card__body">
          {previousStepHint && cfg.model !== previousStepHint.model && (
            <p className="gp-step-card__hint">
              <span>
                {t('use_previous_step_model', {
                  step: t(`steps.${previousStepHint.step}.title` as StepTitleKey),
                  model: previousStepHint.model,
                })}
              </span>
              <Btn kind="ghost" sm onClick={() => reuseFullModelId(previousStepHint.model)}>
                {t('use_previous_button')}
              </Btn>
            </p>
          )}
          <div className="gp-step-card__pickers">
            <select
              className="gp-sselect gp-step-card__provider-select"
              aria-label={t('model_provider_select_aria', {
                step: t(`steps.${stepKey}.title` as StepTitleKey),
              })}
              value={effectiveProvider}
              onChange={(e) => selectProvider(e.target.value)}
              disabled={providerOptions.length === 0}
            >
              <option value="" disabled>
                {providerOptions.length === 0
                  ? t('model_no_provider_configured')
                  : t('model_provider_select_placeholder')}
              </option>
              {providerOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {providerLabel(o.id, tp)}
                </option>
              ))}
            </select>
            <select
              className="gp-sselect gp-sselect--mono gp-step-card__model-select"
              aria-label={t('model_select_aria', {
                step: t(`steps.${stepKey}.title` as StepTitleKey),
              })}
              value={effectiveModel}
              onChange={(e) => selectModel(e.target.value)}
              disabled={effectiveProvider === '' || providerModels.length === 0}
            >
              {effectiveModel === '' ? (
                <option value="" disabled>
                  {providerModels.length === 0 && effectiveProvider !== ''
                    ? t('model_no_models_configured')
                    : t('model_select_placeholder')}
                </option>
              ) : null}
              {providerModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {offListModel ? <option value={effectiveModel}>{effectiveModel} · ?</option> : null}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
