// apps/web/src/app/onboarding/pipeline/page.tsx
//
// F2 — wizard step 2: pipeline LLM configuration. Users pick a provider +
// model for each pipeline step. The chip area, step cards, inline provider
// form, and right-side overview all live in _components/ so other pages can
// reuse them if/when they need similar provider-picker UX (digest summary
// model, embedding model, etc).
//
// Step ordering: A (article analysis) ≫ B (user interaction). Verifier and
// Relator are optional; the rest are required for the wizard's Next button
// to enable.
//
// previousModel(): walks back through STEP_ORDER from the given step and
// returns the most recent step that has a model AND is enabled-or-required.
// We skip optional steps the user disabled — otherwise the hint would
// suggest a model from a step that isn't even being used.
'use client';

import { useTranslations } from 'next-intl';
import { Btn } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { SettingsCard } from '@/components/ui/settings-card';
import { SettingsHead } from '@/components/ui/settings-head';
import { ConfiguredStepsOverview } from '../_components/configured-steps-overview';
import { hasCompleteModelId } from '../_components/model-id';
import { StepCard } from '../_components/step-card';
import { nextVisibleHref, prevVisibleHref, visibleIndex, visibleTotal } from '../_components/steps';
import { WizardProviderList } from '../_components/wizard-provider-list';
import { useWizard, useWizardNavigate } from '../_components/wizard-state';

const REQUIRED_STEPS = [
  'classifier',
  'extractor',
  'matcher',
  'comparator',
  'intent',
  'query',
] as const;

const STEP_ORDER = [
  'classifier',
  'extractor',
  'matcher',
  'comparator',
  'verifier',
  'relator',
  'intent',
  'query',
] as const;

type StepKey = (typeof STEP_ORDER)[number];

export default function PipelinePage() {
  const t = useTranslations('onboarding');
  const tProgress = useTranslations('onboarding.progress');
  const nav = useWizardNavigate();
  const { state } = useWizard();

  function previousModel(step: StepKey): { step: string; model: string } | undefined {
    const idx = STEP_ORDER.indexOf(step);
    if (idx <= 0) return undefined;
    for (let i = idx - 1; i >= 0; i--) {
      const candidate = STEP_ORDER[i];
      const cfg = state.steps[candidate];
      const optional = candidate === 'verifier' || candidate === 'relator';
      if (optional && !cfg?.enabled) continue;
      if (cfg?.model) return { step: candidate, model: cfg.model };
    }
    return undefined;
  }

  // Optional steps (verifier / relator) don't gate Next — only the 6 required
  // steps need a model. If users skip the optional toggles entirely, that's
  // a valid configuration.
  const allRequiredFilled = REQUIRED_STEPS.every((s) => hasCompleteModelId(state.steps[s]?.model));

  return (
    <>
      <SettingsHead
        crumb={tProgress('step_n_of_total', {
          current: visibleIndex('pipeline'),
          total: visibleTotal(),
        })}
        heading={t('pipeline_section_title')}
        desc={t('pipeline_intro_banner')}
      />

      <div className="gp-onboarding-pipeline">
        <div className="gp-onboarding-pipeline__main">
          {/* Provider configuration — visually mirrors the settings page
              «LLM Provider» layout (configured-block card + separate add card
              with heading/desc). `WizardProviderList` emits both cards; we
              don't wrap it here. Always rendered (even before any provider is
              added) so users get an obvious entry point instead of having to
              click into a step card to discover the inline form. The
              step-card flow still works — just no longer the only way in. */}
          <WizardProviderList />

          <SettingsCard heading={t('section_a_title')}>
            {(['classifier', 'extractor', 'matcher', 'comparator'] as const).map((s, i) => (
              <StepCard
                key={s}
                stepKey={s}
                index={i + 1}
                total={6}
                previousStepHint={previousModel(s)}
              />
            ))}
            <StepCard
              stepKey="verifier"
              optional
              index={5}
              total={6}
              previousStepHint={previousModel('verifier')}
            />
            <StepCard
              stepKey="relator"
              optional
              index={6}
              total={6}
              previousStepHint={previousModel('relator')}
            />
          </SettingsCard>

          <SettingsCard heading={t('section_b_title')}>
            {(['intent', 'query'] as const).map((s, i) => (
              <StepCard
                key={s}
                stepKey={s}
                index={i + 1}
                total={2}
                previousStepHint={previousModel(s)}
              />
            ))}
          </SettingsCard>

          {/* Embedding 暂时不在向导内单列一步（见 _components/steps.ts 的 hidden
              标记）。默认 disabled 即可正常使用 FTS5 关键词检索；想开启向量
              混合检索的用户在完成向导后到「设置 → Embedding」启用即可。这里
              只是一个轻量提示，不影响 Next 校验。 */}
          <Notice kind="info" heading={t('embedding_hint_title')}>
            {t('embedding_hint_body')}
          </Notice>
        </div>

        <aside className="gp-onboarding-pipeline__aside">
          <p className="gp-onboarding-pipeline__aside-title">{t('configured_steps_overview')}</p>
          <ConfiguredStepsOverview currentStep="" />
        </aside>
      </div>

      <div className="gp-onboarding__actions gp-onboarding__actions--split">
        <Btn kind="ghost" onClick={() => nav(prevVisibleHref('pipeline'))}>
          {t('back_button')}
        </Btn>
        <Btn
          kind="primary"
          disabled={!allRequiredFilled}
          onClick={() => nav(nextVisibleHref('pipeline'))}
        >
          {t('next_button')}
        </Btn>
      </div>
    </>
  );
}
