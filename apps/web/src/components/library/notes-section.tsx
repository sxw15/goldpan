'use client';

import type { NoteDetail } from '@goldpan/web-sdk';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import type { InspectorPayload } from '../inspector/payloads/types';
import { StateEmpty } from '../state/state-empty';
import { StateError } from '../state/state-error';
import type { SectionResult } from './library-shell';
import { NoteCard } from './note-card';

// `archived` is a top-level filter rather than another subtype because the
// active list (subtype=all/memo/note) excludes archived entries entirely.
// Mixing archived into the same axis would either double-count or hide entries
// from subtype counts after archiving — both confuse the user.
type SubtypeFilter = 'all' | 'archived' | 'memo' | 'note';

interface NotesSectionProps {
  result: SectionResult<NoteDetail>;
  /** Separate list — page-level fetch passes `{ archived: true }` notes here.
   * When the user selects the `archived` filter we render this list instead
   * of `result.ok`. We intentionally do NOT mix archived rows back into the
   * main list because the active subtype counts would otherwise count
   * archived notes too. */
  archivedNotes: NoteDetail[];
  archivedNotesError?: string;
  onOpenPayload: (payload: InspectorPayload) => void;
}

export function NotesSection({
  result,
  archivedNotes,
  archivedNotesError,
  onOpenPayload,
}: NotesSectionProps) {
  const t = useTranslations('library');
  const router = useRouter();
  const [filter, setFilter] = useState<SubtypeFilter>('all');

  const notes = 'ok' in result ? result.ok : [];

  const { filtered, counts } = useMemo(() => {
    const cts = {
      all: notes.length,
      archived: archivedNotes.length,
      memo: 0,
      note: 0,
    };
    for (const n of notes) cts[n.subtype]++;
    const list =
      filter === 'archived'
        ? archivedNotes
        : filter === 'all'
          ? notes
          : notes.filter((n) => n.subtype === filter);
    const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt);
    return { filtered: sorted, counts: cts };
  }, [notes, archivedNotes, filter]);

  if ('error' in result) {
    // P5 Fix Batch 6 (M4): pass onRetry={router.refresh} so the error envelope
    // renders an actionable retry button (StateError hides the button without
    // it). Mirrors EntitiesSection / SourcesSection — section-level errors are
    // recoverable via the same server component refetch.
    return (
      <StateError
        error={result.error}
        onRetry={() => router.refresh()}
        retryLabel={t('section_retry')}
      />
    );
  }

  const isArchivedView = filter === 'archived';
  const isEmpty = isArchivedView ? archivedNotes.length === 0 : notes.length === 0;
  const isFilteredEmpty = !isEmpty && filtered.length === 0;

  const subtypeKeys: SubtypeFilter[] = ['all', 'memo', 'note', 'archived'];

  // Section heading swaps to "归档笔记" when archived view is active so the
  // user immediately understands the list semantics shifted (these rows are
  // hidden from the default view, do not contribute to subtype counts, etc.).
  const sectionTitle = isArchivedView ? t('notes_archived_section_title') : t('section_notes');
  const archivedLoadFailed = archivedNotesError !== undefined;

  return (
    <div className="gp-notes-section">
      <header className="gp-section-head">
        <h2 className="gp-section-head__title gp-library-shell__section-title">
          {sectionTitle}
          {!(isArchivedView && archivedLoadFailed) && (
            <small>{t('notes_count_suffix', { count: filtered.length })}</small>
          )}
        </h2>
      </header>

      <div className="gp-notes-section__filter">
        {subtypeKeys.map((key) => {
          const isArchivedChip = key === 'archived';
          const showLoadFailed = isArchivedChip && archivedLoadFailed;
          return (
            <button
              type="button"
              key={key}
              className={`gp-chip gp-notes-section__filter-chip${filter === key ? ' is-active' : ''}`}
              onClick={() => setFilter(key)}
              title={showLoadFailed ? archivedNotesError : undefined}
            >
              {t(`notes_filter_${key}`)}
              <span className="gp-chip__count">{showLoadFailed ? '!' : counts[key]}</span>
            </button>
          );
        })}
      </div>

      {isArchivedView && archivedLoadFailed ? (
        <StateError
          error={archivedNotesError}
          onRetry={() => router.refresh()}
          retryLabel={t('section_retry')}
        />
      ) : isEmpty ? (
        isArchivedView ? (
          <StateEmpty
            title={t('notes_empty_archived_title')}
            description={t('notes_empty_archived_hint')}
          />
        ) : (
          <StateEmpty title={t('notes_empty_title')} description={t('notes_empty_hint')} />
        )
      ) : isFilteredEmpty ? (
        <StateEmpty
          title={t('notes_empty_filtered_title')}
          description={t('notes_empty_filtered_hint')}
          action={
            <button
              type="button"
              className="gp-btn"
              data-variant="track"
              onClick={() => setFilter('all')}
            >
              {t('notes_empty_clear_filter')}
            </button>
          }
        />
      ) : (
        <ul className="gp-notes-section__list">
          {filtered.map((n) => (
            <NoteCard key={n.id} note={n} onOpen={onOpenPayload} />
          ))}
        </ul>
      )}
    </div>
  );
}
