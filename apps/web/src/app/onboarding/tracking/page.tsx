'use client';

import { useTranslations } from 'next-intl';
import { Btn } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { SettingsCard } from '@/components/ui/settings-card';
import { SettingsHead } from '@/components/ui/settings-head';
import { Toggle } from '@/components/ui/toggle';
import { nextVisibleHref, prevVisibleHref, visibleIndex, visibleTotal } from '../_components/steps';
import { WizardField } from '../_components/wizard-field';
import { useWizard, useWizardNavigate, type WizardState } from '../_components/wizard-state';

type TrackingState = NonNullable<WizardState['tracking']>;
type TrackingRule = TrackingState['rules'][number];

const SEARCH_PROVIDERS = ['tavily', 'serper', 'google'] as const;
type SearchProviderId = (typeof SEARCH_PROVIDERS)[number];

const SCHEDULE_PRESETS = ['daily', 'weekly', 'interval_6h', 'custom'] as const;
type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];

interface UIRule extends TrackingRule {
  schedulePreset: SchedulePreset;
  searchQueriesText: string;
  domainsText: string;
}

const DEFAULT_TRACKING: TrackingState = {
  enabled: false,
  searchProviders: [],
  rules: [],
};

const DEFAULT_CUSTOM_MINUTES = 60;

function presetToMinutes(preset: SchedulePreset, customMinutes?: number): number {
  switch (preset) {
    case 'daily':
      return 1440;
    case 'weekly':
      return 10080;
    case 'interval_6h':
      return 360;
    case 'custom':
      return Number.isFinite(customMinutes) && (customMinutes ?? 0) > 0
        ? (customMinutes as number)
        : DEFAULT_CUSTOM_MINUTES;
  }
}

function minutesToPreset(min: number): SchedulePreset {
  if (min === 1440) return 'daily';
  if (min === 10080) return 'weekly';
  if (min === 360) return 'interval_6h';
  return 'custom';
}

function ruleToUI(r: TrackingRule): UIRule {
  return {
    ...r,
    schedulePreset: minutesToPreset(r.intervalMinutes),
    searchQueriesText: r.searchQueries.join(', '),
    domainsText: (r.domains ?? []).join(', '),
  };
}

function uiToRule(u: UIRule): TrackingRule {
  const queries = u.searchQueriesText
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const domains = u.domainsText
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    name: u.name,
    searchQueries: queries,
    intervalMinutes: u.intervalMinutes,
    ...(domains.length > 0 ? { domains } : {}),
  };
}

type SearchProviderLabelKey =
  | 'search_provider_tavily'
  | 'search_provider_serper'
  | 'search_provider_google';

type SchedulePresetLabelKey =
  | 'schedule_preset_daily'
  | 'schedule_preset_weekly'
  | 'schedule_preset_interval_6h'
  | 'schedule_preset_custom';

type ApiKeyLabelKey = 'tavily_api_key_label' | 'serper_api_key_label';

export default function TrackingPage() {
  const t = useTranslations('onboarding.tracking');
  const tt = useTranslations('onboarding');
  const tProgress = useTranslations('onboarding.progress');
  const nav = useWizardNavigate();
  const { state, patch } = useWizard();

  const tr: TrackingState = state.tracking ?? DEFAULT_TRACKING;

  function update(partial: Partial<TrackingState>): void {
    void patch({ tracking: { ...tr, ...partial } });
  }

  function toggleSearchProvider(p: SearchProviderId, checked: boolean): void {
    const next = checked
      ? Array.from(new Set([...tr.searchProviders, p]))
      : tr.searchProviders.filter((x) => x !== p);
    update({ searchProviders: next });
  }

  function setSearchKey(key: 'tavily' | 'serper', value: string): void {
    void patch({
      searchKeys: {
        ...(state.searchKeys ?? {}),
        [key]: value || null,
      },
    });
  }

  function addRule(): void {
    const newRule: TrackingRule = {
      name: '',
      searchQueries: [],
      intervalMinutes: 1440, // daily default
    };
    update({ rules: [...tr.rules, newRule] });
  }

  function removeRule(idx: number): void {
    update({ rules: tr.rules.filter((_, i) => i !== idx) });
  }

  function updateRule(idx: number, partial: Partial<UIRule>): void {
    const current = tr.rules[idx];
    if (!current) return;
    const ui = ruleToUI(current);
    const merged: UIRule = { ...ui, ...partial };
    if (partial.schedulePreset !== undefined || partial.intervalMinutes !== undefined) {
      merged.intervalMinutes = presetToMinutes(merged.schedulePreset, merged.intervalMinutes);
    }
    const nextRule = uiToRule(merged);
    const nextRules = tr.rules.map((r, i) => (i === idx ? nextRule : r));
    update({ rules: nextRules });
  }

  return (
    <>
      <SettingsHead
        crumb={tProgress('step_n_of_total', {
          current: visibleIndex('tracking'),
          total: visibleTotal(),
        })}
        heading={t('section_title')}
        desc={t('section_desc')}
      />

      <SettingsCard
        heading={t('enable_label')}
        right={<Toggle on={tr.enabled} onChange={(v) => update({ enabled: v })} />}
      >
        {tr.enabled && (
          <WizardField
            label={t('search_provider_label')}
            control={
              <ul className="gp-onboarding-multicheck">
                {SEARCH_PROVIDERS.map((p) => (
                  <li key={p}>
                    <label>
                      <input
                        type="checkbox"
                        checked={tr.searchProviders.includes(p)}
                        onChange={(e) => toggleSearchProvider(p, e.target.checked)}
                      />
                      <span>{t(`search_provider_${p}` as SearchProviderLabelKey)}</span>
                    </label>
                    {p !== 'google' && tr.searchProviders.includes(p) && (
                      <div className="gp-onboarding-multicheck__nested">
                        <input
                          type="password"
                          value={state.searchKeys?.[p] ?? ''}
                          onChange={(e) => setSearchKey(p, e.target.value)}
                          placeholder={t(`${p}_api_key_label` as ApiKeyLabelKey)}
                          autoComplete="off"
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            }
          />
        )}
      </SettingsCard>

      {tr.enabled && (
        <SettingsCard
          heading={t('rules_label')}
          right={
            <Btn kind="secondary" sm onClick={addRule}>
              {t('add_rule_button')}
            </Btn>
          }
        >
          {tr.rules.length === 0 ? (
            <p className="gp-onboarding-empty">{t('rules_empty_hint')}</p>
          ) : (
            <ul className="gp-onboarding-rules">
              {tr.rules.map((r, idx) => {
                const ui = ruleToUI(r);
                return (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: order is stable within a session — rules are append-only via addRule, and removeRule keeps the remaining indices contiguous; no DnD reorder yet.
                    key={idx}
                    className="gp-onboarding-rule"
                  >
                    <div className="gp-onboarding-rule__head">
                      <input
                        type="text"
                        value={ui.name}
                        onChange={(e) => updateRule(idx, { name: e.target.value })}
                        placeholder={t('rule_name')}
                      />
                      <Btn kind="ghost" sm onClick={() => removeRule(idx)}>
                        {t('remove_rule_button')}
                      </Btn>
                    </div>
                    <WizardField
                      label={t('rule_queries')}
                      control={
                        <input
                          type="text"
                          value={ui.searchQueriesText}
                          onChange={(e) => updateRule(idx, { searchQueriesText: e.target.value })}
                          placeholder={t('rule_queries_placeholder')}
                        />
                      }
                    />
                    <WizardField
                      label={t('rule_schedule')}
                      control={
                        <Segmented<SchedulePreset>
                          value={ui.schedulePreset}
                          options={SCHEDULE_PRESETS.map((p) => ({
                            value: p,
                            label: t(`schedule_preset_${p}` as SchedulePresetLabelKey),
                          }))}
                          onChange={(v) =>
                            updateRule(idx, {
                              schedulePreset: v,
                              intervalMinutes:
                                v === 'custom' ? ui.intervalMinutes : presetToMinutes(v),
                            })
                          }
                        />
                      }
                    />
                    {ui.schedulePreset === 'custom' && (
                      <WizardField
                        label={t('custom_minutes_label')}
                        control={
                          <input
                            type="number"
                            min={1}
                            value={ui.intervalMinutes}
                            onChange={(e) =>
                              updateRule(idx, {
                                schedulePreset: 'custom',
                                intervalMinutes: Number(e.target.value),
                              })
                            }
                          />
                        }
                      />
                    )}
                    <WizardField
                      label={t('rule_domains')}
                      hint={t('domains_v1_1_hint')}
                      control={
                        <input
                          type="text"
                          value={ui.domainsText}
                          onChange={(e) => updateRule(idx, { domainsText: e.target.value })}
                          placeholder={t('rule_domains_placeholder')}
                        />
                      }
                    />
                  </li>
                );
              })}
            </ul>
          )}
          <p className="gp-onboarding-helper gp-onboarding-helper--small">{t('presets_v2_hint')}</p>
        </SettingsCard>
      )}

      <div className="gp-onboarding__actions gp-onboarding__actions--split">
        <Btn kind="ghost" onClick={() => nav(prevVisibleHref('tracking'))}>
          {tt('back_button')}
        </Btn>
        <Btn kind="primary" onClick={() => nav(nextVisibleHref('tracking'))}>
          {tt('next_button')}
        </Btn>
      </div>
    </>
  );
}
