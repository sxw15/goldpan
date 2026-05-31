'use client';

import { useTranslations } from 'next-intl';
import { Btn } from '@/components/ui/button';
import { SettingsCard } from '@/components/ui/settings-card';
import { SettingsHead } from '@/components/ui/settings-head';
import { Toggle } from '@/components/ui/toggle';
import { nextVisibleHref, prevVisibleHref, visibleIndex, visibleTotal } from '../_components/steps';
import { WizardField } from '../_components/wizard-field';
import { useWizard, useWizardNavigate, type WizardState } from '../_components/wizard-state';

type DigestState = NonNullable<WizardState['digest']>;

const MODULES = [
  'stats',
  'tracking_findings',
  'captures',
  'new_entities',
  'thoughts',
  'ai_summary',
] as const;

type Module = (typeof MODULES)[number];

// Typed as DigestState so optional fields (summaryModel / actionModel) stay in
// the narrowed type — otherwise TS infers a literal shape without them and the
// `state.digest ?? DEFAULTS` union loses those properties.
const DEFAULTS: DigestState = {
  enabled: false,
  modules: [...MODULES],
  dailyTime: '06:00',
  maxItemsPerModule: 10,
};

// Provider → model suggestions tuned for digest-quality summarization. Mirrors
// PROVIDER_MODELS in step-card.tsx but only the "summary-quality" tiers — the
// digest summary is user-facing prose, not a quick classifier, so we skip
// gpt-4o-mini and the haiku tier.
const SUMMARY_CANDIDATES: Array<{ provider: string; model: string }> = [
  { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
  { provider: 'openai', model: 'gpt-4o' },
  { provider: 'google', model: 'gemini-1.5-pro' },
  { provider: 'deepseek', model: 'deepseek-v4-pro' },
];

type ModuleLabelKey =
  | 'module_stats'
  | 'module_tracking_findings'
  | 'module_captures'
  | 'module_new_entities'
  | 'module_thoughts'
  | 'module_ai_summary';

export default function DigestPage() {
  const t = useTranslations('onboarding.digest');
  const tt = useTranslations('onboarding');
  const tProgress = useTranslations('onboarding.progress');
  const nav = useWizardNavigate();
  const { state, patch } = useWizard();

  const d: DigestState = state.digest ?? DEFAULTS;

  function update(partial: Partial<DigestState>): void {
    void patch({ digest: { ...d, ...partial } });
  }

  function toggleModule(slot: Module, checked: boolean): void {
    const next = checked ? [...d.modules, slot] : d.modules.filter((m) => m !== slot);
    update({ modules: next });
  }

  // Models: only suggest combinations whose provider was already configured on
  // page 2. Dangling references ("user picked a model whose provider got
  // removed") are prevented by ChipArea's removeProvider sweep, but we still
  // need to filter here so the dropdown reflects current providers.
  const availableModels = SUMMARY_CANDIDATES.filter(({ provider }) =>
    Boolean(state.providers[provider]?.apiKey ?? state.providers[provider]?.baseUrl),
  );

  return (
    <>
      <SettingsHead
        crumb={tProgress('step_n_of_total', {
          current: visibleIndex('digest'),
          total: visibleTotal(),
        })}
        heading={t('section_title')}
        desc={t('section_desc')}
      />

      <SettingsCard
        heading={t('enable_label')}
        right={<Toggle on={d.enabled} onChange={(v) => update({ enabled: v })} />}
      >
        {d.enabled && (
          <>
            <WizardField
              label={t('daily_time_label')}
              control={
                <input
                  type="time"
                  value={d.dailyTime ?? '06:00'}
                  onChange={(e) => update({ dailyTime: e.target.value })}
                />
              }
            />
            <WizardField
              label={t('max_items_label')}
              control={
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={d.maxItemsPerModule ?? 10}
                  onChange={(e) => update({ maxItemsPerModule: Number(e.target.value) })}
                />
              }
            />
            <WizardField
              label={t('summary_model_label')}
              control={
                <select
                  value={d.summaryModel ?? ''}
                  onChange={(e) => update({ summaryModel: e.target.value })}
                >
                  <option value="" disabled>
                    {t('model_dropdown_placeholder')}
                  </option>
                  {availableModels.map(({ provider, model }) => (
                    <option key={`${provider}:${model}`} value={`${provider}:${model}`}>
                      {provider}:{model}
                    </option>
                  ))}
                </select>
              }
            />
            <WizardField
              label={t('action_model_label')}
              control={
                <select
                  value={d.actionModel ?? ''}
                  onChange={(e) => update({ actionModel: e.target.value })}
                >
                  <option value="" disabled>
                    {t('model_dropdown_placeholder')}
                  </option>
                  {availableModels.map(({ provider, model }) => (
                    <option key={`${provider}:${model}`} value={`${provider}:${model}`}>
                      {provider}:{model}
                    </option>
                  ))}
                </select>
              }
            />
            <WizardField
              label={t('modules_label')}
              hint={t('module_order_hint')}
              control={
                <ul className="gp-onboarding-multicheck">
                  {MODULES.map((m) => (
                    <li key={m}>
                      <label>
                        <input
                          type="checkbox"
                          checked={d.modules.includes(m)}
                          onChange={(e) => toggleModule(m, e.target.checked)}
                        />
                        <span>{t(`module_${m}` as ModuleLabelKey)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              }
            />
          </>
        )}
      </SettingsCard>

      <div className="gp-onboarding__actions gp-onboarding__actions--split">
        <Btn kind="ghost" onClick={() => nav(prevVisibleHref('digest'))}>
          {tt('back_button')}
        </Btn>
        <Btn kind="primary" onClick={() => nav(nextVisibleHref('digest'))}>
          {tt('next_button')}
        </Btn>
      </div>
    </>
  );
}
