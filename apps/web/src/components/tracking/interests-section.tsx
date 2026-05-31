'use client';

import type { CreateInterestInput, InterestListItem } from '@goldpan/web-sdk';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTz } from '@/components/tz-provider';
import { formatDateMinute, freqDescriptor } from '@/lib/format';
import type { SectionResult } from '../library/library-shell';
import { StateError } from '../state/state-error';
import { InterestForm } from './interest-form';

interface InterestsSectionProps {
  result: SectionResult<InterestListItem>;
  showNewForm: boolean;
  onToggleNewForm: () => void;
  onSubmitNew: (data: CreateInterestInput) => Promise<void>;
  onOpenInterest: (id: number) => void;
  /**
   * Server-side probe positively confirmed zero runtime-ready search tool
   * providers. When true and the list is empty, the hero swaps to a "configure
   * first" CTA and the new-interest button is suppressed — creating a rule now
   * would just queue an interest that can't run. The shell renders a row-style
   * banner in the non-empty case; the section controls only the empty-state
   * hero copy.
   */
  searchToolWarning?: boolean;
}

// `failed` lives on the inspector side (it reads recent execution errors);
// the listing has no `lastRunStatus` field on InterestListItem, so the row
// can only express the three states derivable from `enabled` + `status`.
type RuleStatus = 'running' | 'idle' | 'disabled';

function deriveStatus(item: InterestListItem): RuleStatus {
  if (!item.enabled) return 'disabled';
  if (item.status === 'executing') return 'running';
  return 'idle';
}

/**
 * 14-bar sparkline. Bar height is normalized against the row's own max so
 * even low-traffic interests show shape — absolute scale is conveyed by the
 * adjacent total hits number, not the bar pixels.
 */
function Sparkline({ values, accent }: { values: number[]; accent: boolean }) {
  const max = Math.max(1, ...values);
  return (
    <span className={`gp-spark${accent ? ' gp-spark--accent' : ''}`} aria-hidden="true">
      {values.map((v, i) => (
        <span
          // Sparkline is decorative, fixed-length, and ordered — index keys are
          // the right choice here (no React-list-id concerns).
          // biome-ignore lint/suspicious/noArrayIndexKey: decorative fixed-length series
          key={i}
          style={{ height: `${Math.round((v / max) * 100)}%` }}
        />
      ))}
    </span>
  );
}

export function InterestsSection({
  result,
  showNewForm,
  onToggleNewForm,
  onSubmitNew,
  onOpenInterest,
  searchToolWarning = false,
}: InterestsSectionProps) {
  const t = useTranslations('tracking');
  const tz = useTz();
  const router = useRouter();

  if ('error' in result) {
    return (
      <StateError
        error={result.error}
        onRetry={() => router.refresh()}
        retryLabel={t('cancel_new')}
      />
    );
  }

  const interests = result.ok;
  const isEmpty = interests.length === 0;

  const enabledCount = interests.filter((i) => i.enabled).length;
  const disabledCount = interests.length - enabledCount;
  const totalHits = interests.reduce((s, i) => s + (i.totalHits ?? 0), 0);
  const new24hTotal = interests.reduce((s, i) => s + (i.newHits24h ?? 0), 0);
  const ingestedTotal = interests.reduce((s, i) => s + (i.ingestedTotal ?? 0), 0);
  const passRate = totalHits > 0 ? Math.round((ingestedTotal / totalHits) * 100) : 0;

  return (
    <section className="gp-interests-section">
      <header className="gp-track-page__head">
        <div>
          <h1>{t('page_title')}</h1>
          <p>{t('page_subtitle')}</p>
        </div>
        {/* Header CTA only when there's at least one rule. Empty state's hero
            owns the primary "+ 新建追踪项" CTA so users have one obvious
            place to act, matching the handoff prototype. */}
        {!isEmpty && !searchToolWarning && (
          <button
            type="button"
            className="gp-track-cta gp-interests-section__new-button"
            onClick={onToggleNewForm}
          >
            {showNewForm ? t('cancel_new') : t('new_interest')}
          </button>
        )}
      </header>

      {!isEmpty && (
        // Each stat tile carries its own label/value/sub copy, so the wrapper
        // only needs to be a styling box — no extra ARIA grouping is needed.
        <div className="gp-track-stats">
          <div className="gp-track-stat">
            <span className="gp-track-stat__label">{t('stat_total_label')}</span>
            <span className="gp-track-stat__value">{interests.length}</span>
            <span className="gp-track-stat__sub">
              {t('stat_total_sub', { running: enabledCount, paused: disabledCount })}
            </span>
          </div>
          <div className="gp-track-stat">
            <span className="gp-track-stat__label">{t('stat_new24h_label')}</span>
            <span className="gp-track-stat__value">{new24hTotal}</span>
            <span className="gp-track-stat__sub">{t('stat_new24h_sub')}</span>
          </div>
          <div className="gp-track-stat">
            <span className="gp-track-stat__label">{t('stat_total_hits_label')}</span>
            <span className="gp-track-stat__value">{totalHits}</span>
            <span className="gp-track-stat__sub">{t('stat_total_hits_sub')}</span>
          </div>
          <div className="gp-track-stat">
            <span className="gp-track-stat__label">{t('stat_ingested_label')}</span>
            <span className="gp-track-stat__value">{ingestedTotal}</span>
            <span className="gp-track-stat__sub">{t('stat_ingested_sub', { rate: passRate })}</span>
          </div>
        </div>
      )}

      {isEmpty ? (
        <EmptyHero onCreate={onToggleNewForm} t={t} searchToolWarning={searchToolWarning} />
      ) : (
        <ul className="gp-interests-section__list gp-rule-list">
          {interests.map((interest) => {
            const status = deriveStatus(interest);
            const statusLabel = t(`row_status_${status}` as const);
            const modifier = interest.enabled ? '' : ' gp-interests-section__item--disabled';
            const keywords = interest.searchQueries;
            const keywordsShown = keywords.slice(0, 3);
            const keywordsExtra = keywords.length - keywordsShown.length;
            return (
              <li key={interest.id} className={`gp-interests-section__item${modifier}`}>
                <button
                  type="button"
                  className="gp-rule-row"
                  onClick={() => onOpenInterest(interest.id)}
                  // Always expose status to AT regardless of whether the
                  // visible label is rendered (it gets replaced by the
                  // ingested caption when newHits24h === 0). Without this,
                  // non-sighted users had only the aria-hidden colored dot.
                  aria-label={`${interest.name} · ${statusLabel}`}
                >
                  {/* Decorative status dot — the row's accessible name comes
                      from the interest name + visible "运行中/闲置/已暂停"
                      text below, so the dot itself is hidden from AT. */}
                  <span className={`gp-rule-dot gp-rule-dot--${status}`} aria-hidden="true" />
                  <div style={{ minWidth: 0 }}>
                    <div className="gp-rule-row__name gp-interests-section__name">
                      {interest.name}
                    </div>
                    <div className="gp-rule-row__keywords">
                      {keywordsShown.map((k) => (
                        <span key={k} className="gp-kw">
                          {k}
                        </span>
                      ))}
                      {keywordsExtra > 0 && (
                        <span className="gp-kw gp-kw--more">+{keywordsExtra}</span>
                      )}
                    </div>
                  </div>
                  <div className="gp-rule-row__metrics">
                    <span className="gp-rule-row__metrics-line">
                      <span className="gp-rule-row__hits">{interest.totalHits ?? 0}</span>
                      <span className="gp-rule-row__hits-sub">{t('row_hits_label')}</span>
                      {(interest.newHits24h ?? 0) > 0 && (
                        <span className="gp-rule-row__hits-new">
                          {t('row_hits_new', { n: interest.newHits24h })}
                        </span>
                      )}
                    </span>
                    {(interest.newHits24h ?? 0) > 0 ? (
                      <span className="gp-rule-row__hits-sub">{statusLabel}</span>
                    ) : (
                      <span className="gp-rule-row__hits-sub">
                        {t('row_ingested_caption', { n: interest.ingestedTotal ?? 0 })}
                      </span>
                    )}
                  </div>
                  <Sparkline
                    values={interest.sparkline ?? []}
                    accent={(interest.newHits24h ?? 0) > 0}
                  />
                  <div className="gp-rule-row__metrics">
                    {interest.lastRunAt ? (
                      <span className="gp-rule-row__hits-sub">
                        {t('row_last_run', { at: formatDateMinute(interest.lastRunAt, tz) })}
                      </span>
                    ) : (
                      <span className="gp-rule-row__hits-sub">{t('row_never_ran')}</span>
                    )}
                  </div>
                  <div className="gp-rule-row__freq">
                    <span>
                      <b>
                        {(() => {
                          const f = freqDescriptor(interest.intervalMinutes);
                          return f.n !== undefined ? t(f.key, { n: f.n }) : t(f.key);
                        })()}
                      </b>
                    </span>
                    {interest.nextRunAt ? (
                      <span className="gp-rule-row__next">
                        ↻ {formatDateMinute(interest.nextRunAt, tz)}
                      </span>
                    ) : (
                      <span className="gp-rule-row__next">{t('row_paused')}</span>
                    )}
                  </div>
                  {/* Decorative pill mirroring the enable state. The real
                      toggle lives in the Inspector — clicking the row opens
                      the Inspector where the user can flip it. */}
                  <span
                    className="gp-rule-row__toggle"
                    data-on={interest.enabled ? 'true' : 'false'}
                    aria-hidden="true"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {showNewForm && !searchToolWarning && (
        <CreateInterestModal
          onCancel={onToggleNewForm}
          onSubmit={onSubmitNew}
          title={t('modal_create_title')}
          closeLabel={t('modal_close_label')}
        />
      )}
    </section>
  );
}

function EmptyHero({
  onCreate,
  t,
  searchToolWarning,
}: {
  onCreate: () => void;
  t: (key: string) => string;
  searchToolWarning: boolean;
}) {
  // The 01/02/03 steps stay in both modes — they're the "how it'll work once
  // you're set up" explainer, useful as orientation even (especially) for the
  // "go configure first" path. Only the title / hint / primary CTA flip.
  return (
    <div className="gp-track-hero">
      <div className="gp-track-hero__radar">
        <div className="gp-track-hero__radar-core" />
      </div>
      <h2 className="gp-track-hero__title">
        {searchToolWarning ? t('hero_needs_search_title') : t('hero_title')}
      </h2>
      {/* Keep the legacy "还没有追踪项" string mounted as a screen-reader hint: tests
          assert it as the canonical empty signal, and the visible hero copy uses
          a richer paraphrase. */}
      <p className="gp-sr-only">{t('empty_title')}</p>
      <p className="gp-track-hero__hint">
        {searchToolWarning ? t('hero_needs_search_hint') : t('hero_hint')}
      </p>
      <div className="gp-track-hero__actions">
        {searchToolWarning ? (
          // Suppress the new-interest button in the un-configured state: a
          // rule authored now would just sit there with no engine to run it,
          // so the only legible next step is settings. Plain anchor (not
          // <Link>) keeps the navigation behavior identical to the row-banner
          // CTA when it also exists.
          <a className="gp-track-cta" href="/settings?group=search">
            {t('hero_needs_search_cta')}
          </a>
        ) : (
          <button type="button" className="gp-track-cta" onClick={onCreate}>
            {t('hero_cta_create')}
          </button>
        )}
      </div>
      <div className="gp-track-hero__how">
        <div className="gp-track-hero__step">
          <span className="gp-track-hero__step-no">01</span>
          <span className="gp-track-hero__step-t">{t('hero_step_1_title')}</span>
          <span className="gp-track-hero__step-d">{t('hero_step_1_desc')}</span>
        </div>
        <div className="gp-track-hero__step">
          <span className="gp-track-hero__step-no">02</span>
          <span className="gp-track-hero__step-t">{t('hero_step_2_title')}</span>
          <span className="gp-track-hero__step-d">{t('hero_step_2_desc')}</span>
        </div>
        <div className="gp-track-hero__step">
          <span className="gp-track-hero__step-no">03</span>
          <span className="gp-track-hero__step-t">{t('hero_step_3_title')}</span>
          <span className="gp-track-hero__step-d">{t('hero_step_3_desc')}</span>
        </div>
      </div>
    </div>
  );
}

interface CreateInterestModalProps {
  onCancel: () => void;
  onSubmit: (data: CreateInterestInput) => Promise<void>;
  title: string;
  closeLabel: string;
}

function CreateInterestModal({ onCancel, onSubmit, title, closeLabel }: CreateInterestModalProps) {
  // ESC closes; backdrop click closes; the dialog itself stops propagation so
  // clicks inside the form don't bubble up to the backdrop's "click to close"
  // handler. The backdrop is presentational — keyboard users dismiss via the
  // explicit close ✕ or ESC, both of which are exposed to assistive tech.
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop is presentational; ESC + close button are the keyboard paths.
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is intentional; ESC handled on inner dialog.
    <div className="gp-track-modal-bd" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="gp-track-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
        }}
      >
        <div className="gp-track-modal__head">
          <h3>{title}</h3>
          <button
            type="button"
            className="gp-track-modal__close"
            onClick={onCancel}
            aria-label={closeLabel}
          >
            ✕
          </button>
        </div>
        <div className="gp-track-modal__body">
          <InterestForm mode="new" onSubmit={onSubmit} onCancel={onCancel} />
        </div>
      </div>
    </div>
  );
}
