// apps/web/src/app/onboarding/_components/configured-steps-overview.tsx
//
// Right-side panel on the F2 Pipeline page giving the user a single-glance
// status of all 8 steps:
//   ▶ accent     — currentStep (caller-supplied; the page can pass '' if it
//                  has no notion of "in-flight step")
//   ✓ ok        — step has a model picked (or, for optional steps, enabled
//                  AND model)
//   ○ faint     — empty / unconfigured (or, for optional disabled steps,
//                  rendered with the "(optional)" suffix to make clear it's
//                  intentional, not just unfinished)
//
// The list mirrors STEP_ORDER on the page; keep them in sync.
'use client';

import { useTranslations } from 'next-intl';
import { useWizard } from './wizard-state';

const STEPS = [
  'classifier',
  'extractor',
  'matcher',
  'comparator',
  'verifier',
  'relator',
  'intent',
  'query',
] as const;

type StepTitleKey =
  | 'steps.classifier.title'
  | 'steps.extractor.title'
  | 'steps.matcher.title'
  | 'steps.comparator.title'
  | 'steps.verifier.title'
  | 'steps.relator.title'
  | 'steps.intent.title'
  | 'steps.query.title';

export function ConfiguredStepsOverview({ currentStep }: { currentStep: string }) {
  const t = useTranslations('onboarding');
  const { state } = useWizard();
  return (
    <ol className="gp-onboarding-overview">
      {STEPS.map((s) => {
        const cfg = state.steps[s];
        const optional = s === 'verifier' || s === 'relator';
        const title = t(`steps.${s}.title` as StepTitleKey);
        if (optional && !cfg?.enabled) {
          return (
            <li key={s} className="gp-onboarding-overview__item" data-state="optional-off">
              <span aria-hidden="true">○</span>
              <span>{title}</span>
            </li>
          );
        }
        if (s === currentStep) {
          return (
            <li key={s} className="gp-onboarding-overview__item" data-state="current">
              <span aria-hidden="true">▶</span>
              <span>
                {title}（{t('step_currently_configuring')}）
              </span>
            </li>
          );
        }
        if (cfg?.model) {
          // Strip the `provider:` prefix — the user already sees which provider
          // is picked in the step card on the left, repeating it in this 240px
          // rail just forces ugly mid-id wrapping. Leaves model ids that
          // happen to contain ':' themselves (e.g. ollama "llama3.2:8b") intact.
          const modelOnly = cfg.model.includes(':')
            ? cfg.model.slice(cfg.model.indexOf(':') + 1)
            : cfg.model;
          return (
            <li key={s} className="gp-onboarding-overview__item" data-state="done">
              <span aria-hidden="true">✓</span>
              <span>{title}</span>
              <span className="gp-onboarding-overview__model" title={cfg.model}>
                {modelOnly}
              </span>
            </li>
          );
        }
        return (
          <li key={s} className="gp-onboarding-overview__item" data-state="upcoming">
            <span aria-hidden="true">○</span>
            <span>{title}</span>
          </li>
        );
      })}
    </ol>
  );
}
