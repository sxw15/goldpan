'use client';

import type { Entity } from '@goldpan/web-sdk';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { useTz } from '@/components/tz-provider';
import { formatDateOnly } from '@/lib/format';
import { StateEmpty } from '../state/state-empty';
import { StateError } from '../state/state-error';
import { type CategoryItem, CategoryPills } from './category-rail';
import { LibraryEmptySuggestions } from './empty-suggestions';
import type { SectionResult } from './library-shell';

type SortKey = 'recent_desc' | 'name_asc' | 'activity_desc';

const SPARK_BARS: ReadonlyArray<{ seed: number; ix: number }> = [
  { seed: 3, ix: 0 },
  { seed: 5, ix: 1 },
  { seed: 2, ix: 2 },
  { seed: 7, ix: 3 },
  { seed: 4, ix: 4 },
  { seed: 6, ix: 5 },
  { seed: 8, ix: 6 },
];

interface EntitiesSectionProps {
  result: SectionResult<Entity>;
  onOpenEntity: (id: number) => void;
  category: string;
  onCategoryChange: (id: string) => void;
  categoryItems: readonly CategoryItem[];
}

function avatarColorClass(id: number): string {
  return `gp-avatar--c${id % 7}`;
}

function avatarInitial(name: string): string {
  const stripped = name.replace(/[\s"“”·]/g, '');
  return (stripped[0] || 'N').toUpperCase();
}

export function EntitiesSection({
  result,
  onOpenEntity,
  category,
  onCategoryChange,
  categoryItems,
}: EntitiesSectionProps) {
  const t = useTranslations('library');
  const tz = useTz();
  const router = useRouter();
  const [sort, setSort] = useState<SortKey>('recent_desc');
  const [search, setSearch] = useState<string>('');

  const entities = 'ok' in result ? result.ok : [];

  const filtered = useMemo(() => {
    let out = entities;
    if (category) {
      // Server emits some paths with a leading slash, the test fixtures use the
      // bare form. Match either by normalising both sides — the rail emits ids
      // in slash form so `category` may or may not start with one.
      const normCat = category.replace(/^\//, '');
      out = out.filter((e) =>
        e.categoryPaths
          .map((p) => p.replace(/^\//, ''))
          .some((p) => p === normCat || p.startsWith(`${normCat}/`)),
      );
    }
    if (search) {
      const needle = search.toLowerCase();
      out = out.filter((e) => e.name.toLowerCase().includes(needle));
    }
    const sorted = [...out];
    if (sort === 'recent_desc') {
      sorted.sort((a, b) => b.createdAt - a.createdAt);
    } else if (sort === 'name_asc') {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      sorted.sort((a, b) => b.activePointCount - a.activePointCount);
    }
    return sorted;
  }, [entities, category, search, sort]);

  if ('error' in result) {
    return (
      <StateError
        error={result.error}
        onRetry={() => router.refresh()}
        retryLabel={t('section_retry')}
      />
    );
  }

  const isFiltered = Boolean(category || search);

  return (
    <div className="gp-entities-section">
      <header className="gp-section-head">
        <h2 className="gp-section-head__title gp-library-shell__section-title">
          {t('section_entities')}
          <small>{t('entities_count_suffix', { count: filtered.length })}</small>
        </h2>
        <div className="gp-section-head__tools">
          <div className="gp-page-search">
            <span className="gp-page-search__icon" aria-hidden="true">
              ⌕
            </span>
            <input
              type="text"
              placeholder={t('entities_search_placeholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="gp-pill-select"
            aria-label={t('entities_sort_label')}
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="recent_desc">{t('entities_sort_recent_desc')}</option>
            <option value="name_asc">{t('entities_sort_name_asc')}</option>
            <option value="activity_desc">{t('entities_sort_activity_desc')}</option>
          </select>
        </div>
      </header>

      {/* Mobile category pill bar — hidden by CSS on desktop where rail handles it */}
      {categoryItems.length > 0 && (
        <div className="gp-entities-section__pills">
          <CategoryPills items={categoryItems} active={category} onChange={onCategoryChange} />
        </div>
      )}

      {filtered.length === 0 ? (
        entities.length === 0 ? (
          <>
            <StateEmpty title={t('entities_empty_title')} description={t('entities_empty_hint')} />
            <LibraryEmptySuggestions />
          </>
        ) : isFiltered ? (
          <StateEmpty
            title={t('entities_empty_filtered_title')}
            description={t('entities_empty_filtered_hint')}
            action={
              <button
                type="button"
                className="gp-btn"
                data-variant="track"
                onClick={() => {
                  onCategoryChange('');
                  setSearch('');
                }}
              >
                {t('entities_empty_clear_filters')}
              </button>
            }
          />
        ) : (
          <StateEmpty title={t('entities_empty_title')} />
        )
      ) : (
        <ul className="gp-entities-section__grid">
          {filtered.map((e) => {
            const path = e.categoryPaths[0] ?? '';
            const updated = formatDateOnly(e.createdAt, tz);
            return (
              <li key={e.id}>
                <button
                  type="button"
                  className="gp-entities-section__card gp-entity-card"
                  onClick={() => onOpenEntity(e.id)}
                >
                  <span className="gp-entity-card__top">
                    <span
                      className={`gp-entity-card__avatar ${avatarColorClass(e.id)}`}
                      aria-hidden="true"
                    >
                      {avatarInitial(e.name)}
                    </span>
                    <span className="gp-entity-card__name">{e.name}</span>
                    <span className="gp-entities-section__card-count gp-entity-card__count">
                      <b>{e.activePointCount}</b>
                      <span>·KP</span>
                    </span>
                  </span>
                  {path && (
                    <span className="gp-entities-section__card-categories gp-entity-card__path">
                      {path}
                    </span>
                  )}
                  <span className="gp-entity-card__meta">
                    <span className="gp-entity-card__spark" aria-hidden="true">
                      {SPARK_BARS.map(({ seed, ix }) => {
                        const height = Math.min(12, seed + ((e.id * (ix + 1)) % 6));
                        return (
                          <span
                            key={`bar-${e.id}-${seed}-${ix}`}
                            style={{ height: `${height}px` }}
                          />
                        );
                      })}
                    </span>
                    <span>{t('entity_card_updated_prefix', { date: updated })}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
