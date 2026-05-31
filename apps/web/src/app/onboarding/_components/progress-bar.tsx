// State derived from the URL so back/forward navigation updates without a refetch.
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type StepSlug, VISIBLE_STEPS } from './steps';

export function ProgressBar() {
  const pathname = usePathname();
  const t = useTranslations('onboarding.progress');

  // Strip /onboarding prefix; '' (root) → 'basic'. Trailing slash tolerated.
  const trimmed = pathname.replace(/^\/onboarding\/?/, '');
  const currentSlug = (trimmed === '' ? 'basic' : trimmed) as StepSlug;
  const idx = VISIBLE_STEPS.findIndex((s) => s.slug === currentSlug);
  // Unknown slug, or user landed on a hidden step's URL directly → snap to
  // step 0 so we still render a partial trail without crashing.
  const currentIdx = idx >= 0 ? idx : 0;
  const totalSteps = VISIBLE_STEPS.length;
  const fillPercent = ((currentIdx + 1) / totalSteps) * 100;
  const currentLabel = t(VISIBLE_STEPS[currentIdx].slug);

  return (
    <nav className="gp-stepper" aria-label={t('aria_label')}>
      <div className="gp-stepper__mobile">
        <p className="gp-stepper__mobile-label">
          {t('step_n_of_total', { current: currentIdx + 1, total: totalSteps })}
          <span className="gp-stepper__mobile-sep">·</span>
          <span className="gp-stepper__mobile-name">{currentLabel}</span>
        </p>
        <div className="gp-stepper__mobile-bar">
          <span className="gp-stepper__mobile-fill" style={{ width: `${fillPercent}%` }} />
        </div>
      </div>
      <ol className="gp-stepper__list">
        {VISIBLE_STEPS.map((step, i) => {
          const state = i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'upcoming';
          const dot = (
            <span className="gp-stepper__dot" aria-hidden="true">
              {state === 'done' ? '✓' : i + 1}
            </span>
          );
          const label = <span className="gp-stepper__label">{t(step.slug)}</span>;
          // Done steps link back; current is rendered as a non-interactive
          // marker (aria-current=step is the a11y signal). Upcoming steps stay
          // non-clickable so users don't skip past required fields — Next is
          // already gated by per-page validation, but a click-to-skip would
          // bypass that gate.
          return (
            <li
              key={step.slug}
              className="gp-stepper__item"
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              {state === 'done' ? (
                <Link href={step.href} className="gp-stepper__link">
                  {dot}
                  {label}
                </Link>
              ) : (
                <>
                  {dot}
                  {label}
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
