'use client';

import type { SourceListItem, SourceStatusCounts } from '@goldpan/web-sdk';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { useTz } from '@/components/tz-provider';
import { formatDateOnly } from '@/lib/format';
import type { InspectorPayload } from '../inspector/payloads/types';
import { StateEmpty } from '../state/state-empty';
import { StateError } from '../state/state-error';
import type { SectionResult } from './library-shell';

type LibraryTranslator = ReturnType<typeof useTranslations<'library'>>;

interface SourcesSectionProps {
  result: SectionResult<SourceListItem>;
  onOpenPayload: (payload: InspectorPayload) => void;
  /** "" = all categories. */
  category: string;
  onCategoryChange: (id: string) => void;
  counts: SourceStatusCounts;
  /** Server signaled the confirmed_empty secondary fetch failed (the main
   * `confirmed` list still rendered). Surface a small inline notice so the
   * user knows the fold group may be incomplete — silently dropping it would
   * make a transient outage look like "no empty sources at all". */
  confirmedEmptyFailed?: boolean;
}

const URL_DISPLAY_LIMIT = 60;
const PREVIEW_LIMIT = 80;

function matchCategory(paths: readonly string[], category: string): boolean {
  if (!category) return true;
  const norm = category.replace(/^\//, '');
  return paths.some((p) => {
    const np = p.replace(/^\//, '');
    return np === norm || np.startsWith(`${norm}/`);
  });
}

function shortenUrl(url: string): string {
  const stripped = url.replace(/^https?:\/\//, '');
  return stripped.length > URL_DISPLAY_LIMIT
    ? `${stripped.slice(0, URL_DISPLAY_LIMIT)}…`
    : stripped;
}

interface SourceRowProps {
  source: SourceListItem;
  onOpenPayload: (payload: InspectorPayload) => void;
  muted?: boolean;
  t: LibraryTranslator;
  tz: string;
}

function SourceRow({ source, onOpenPayload, muted, t, tz }: SourceRowProps) {
  const date = formatDateOnly(source.createdAt, tz);
  const kindLabel = t(
    source.kind === 'external' ? 'source_kind_label_url' : 'source_kind_label_user_text',
  );
  const identity = (() => {
    if (source.title?.trim()) return { label: source.title.trim(), italic: false };
    if (source.originalUrl) return { label: shortenUrl(source.originalUrl), italic: false };
    if (source.kind === 'user' && source.preview) {
      return {
        label: t('source_preview_quoted', { snippet: source.preview.slice(0, PREVIEW_LIMIT) }),
        italic: true,
      };
    }
    return { label: t('source_untitled', { id: source.id }), italic: true };
  })();

  return (
    <li>
      <button
        type="button"
        className={`gp-sources-section__item gp-source-row${muted ? ' gp-source-row--muted' : ''}`}
        onClick={() => onOpenPayload({ kind: 'source', id: source.id })}
      >
        {!muted && (
          <div className="gp-source-row__primary">
            <span className="gp-source-row__pill">
              <b>{source.kpCount}</b>
              <span>·KP</span>
            </span>
            {source.topEntities.map((e) => (
              <span key={e.id} className="gp-source-row__chip">
                {e.name}
              </span>
            ))}
            {source.entityCount > source.topEntities.length && (
              <span className="gp-source-row__chip gp-source-row__chip--more">
                {t('sources_entities_more', {
                  count: source.entityCount - source.topEntities.length,
                })}
              </span>
            )}
          </div>
        )}
        <div className="gp-source-row__secondary">
          <span className="gp-source-row__kind">{kindLabel}</span>
          <span
            className={`gp-source-row__identity${identity.italic ? ' gp-source-row__identity--placeholder' : ''}`}
          >
            {identity.label}
          </span>
          <span className="gp-source-row__date">{date}</span>
        </div>
      </button>
    </li>
  );
}

function StatusIndicatorStrip({ counts, t }: { counts: SourceStatusCounts; t: LibraryTranslator }) {
  const segments: string[] = [];
  if (counts.processing > 0)
    segments.push(t('sources_status_seg_processing', { count: counts.processing }));
  if (counts.failed > 0) segments.push(t('sources_status_seg_failed', { count: counts.failed }));
  if (counts.discarded > 0)
    segments.push(t('sources_status_seg_discarded', { count: counts.discarded }));
  if (segments.length === 0) return null;
  return (
    <div className="gp-source-status-strip" role="status">
      <span className="gp-source-status-strip__counts">{segments.join(' · ')}</span>
      <Link className="gp-source-status-strip__link" href="/tasks">
        {t('sources_status_indicator_link')}
      </Link>
    </div>
  );
}

function CollapsibleGroup({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="gp-source-fold-group">
      <button
        type="button"
        className="gp-source-fold-group__head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="gp-source-fold-group__caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span>{title}</span>
      </button>
      {open && <div className="gp-source-fold-group__body">{children}</div>}
    </div>
  );
}

export function SourcesSection({
  result,
  onOpenPayload,
  category,
  onCategoryChange,
  counts,
  confirmedEmptyFailed,
}: SourcesSectionProps) {
  const t = useTranslations('library');
  const tz = useTz();
  const router = useRouter();
  const sources = 'ok' in result ? result.ok : [];

  const { confirmed, confirmedFiltered, confirmedEmptyFiltered } = useMemo(() => {
    const confirmedAll = sources.filter((s) => s.status === 'confirmed');
    const confirmedEmpty = sources.filter((s) => s.status === 'confirmed_empty');
    const filteredConfirmed = confirmedAll.filter((s) =>
      matchCategory(s.entityCategoryPaths, category),
    );
    const filteredConfirmedEmpty = category ? [] : confirmedEmpty;
    return {
      confirmed: confirmedAll,
      confirmedFiltered: filteredConfirmed,
      confirmedEmptyFiltered: filteredConfirmedEmpty,
    };
  }, [sources, category]);

  if ('error' in result) {
    return (
      <StateError
        error={result.error}
        onRetry={() => router.refresh()}
        retryLabel={t('section_retry')}
      />
    );
  }

  const isFilteredOut = Boolean(category) && confirmed.length > 0 && confirmedFiltered.length === 0;

  return (
    <div className="gp-sources-section">
      <header className="gp-section-head">
        <h2 className="gp-section-head__title gp-library-shell__section-title">
          {t('section_sources')}
          <small>{t('sources_main_count_suffix', { count: confirmedFiltered.length })}</small>
        </h2>
      </header>

      <StatusIndicatorStrip counts={counts} t={t} />

      {confirmedFiltered.length === 0 ? (
        isFilteredOut ? (
          <StateEmpty
            title={t('sources_empty_filtered_title')}
            description={t('sources_empty_filtered_hint')}
            action={
              <button
                type="button"
                className="gp-btn"
                data-variant="track"
                onClick={() => onCategoryChange('')}
              >
                {t('sources_empty_clear_category')}
              </button>
            }
          />
        ) : (
          <StateEmpty title={t('sources_empty_title')} description={t('sources_empty_hint')} />
        )
      ) : (
        <ul className="gp-sources-section__list">
          {confirmedFiltered.map((s) => (
            <SourceRow key={s.id} source={s} onOpenPayload={onOpenPayload} t={t} tz={tz} />
          ))}
        </ul>
      )}

      {confirmedEmptyFiltered.length > 0 && (
        <CollapsibleGroup
          title={t('sources_empty_group_title', { count: confirmedEmptyFiltered.length })}
        >
          <ul className="gp-sources-section__list">
            {confirmedEmptyFiltered.map((s) => (
              <SourceRow key={s.id} source={s} onOpenPayload={onOpenPayload} muted t={t} tz={tz} />
            ))}
          </ul>
        </CollapsibleGroup>
      )}

      {confirmedEmptyFailed && (
        <p className="gp-sources-section__degraded" role="status">
          {t('confirmed_empty_partial_failure')}
        </p>
      )}
    </div>
  );
}
