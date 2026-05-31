'use client';

import type { Entity } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

export interface CategoryItem {
  id: string;
  label: string;
  depth: number;
  count: number;
}

/**
 * Build a flat, depth-tagged category list from the entities. Server emits
 * category paths with a leading slash (e.g. `/科技/AI/大模型`); rail item ids
 * keep the same shape so equality comparisons in the filter logic
 * (`entity.categoryPaths.some(p => p === id || p.startsWith(id + '/'))`) match
 * the server canon without needing per-call normalization.
 */
export function buildCategoryItems(entities: readonly Entity[]): CategoryItem[] {
  const counts = new Map<string, number>();
  for (const e of entities) {
    const seen = new Set<string>();
    for (const p of e.categoryPaths) {
      const segs = p.split('/').filter(Boolean);
      for (let i = 1; i <= segs.length; i++) {
        seen.add(`/${segs.slice(0, i).join('/')}`);
      }
    }
    for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return Array.from(counts.keys())
    .sort()
    .map((p) => {
      const segs = p.split('/').filter(Boolean);
      return {
        id: p,
        label: segs[segs.length - 1] ?? p,
        depth: Math.max(0, segs.length - 1),
        count: counts.get(p) ?? 0,
      };
    });
}

interface CategoryRailProps {
  items: readonly CategoryItem[];
  totalCount: number;
  active: string;
  onChange: (id: string) => void;
}

export function CategoryRail({ items, totalCount, active, onChange }: CategoryRailProps) {
  const t = useTranslations('library');
  const allLabel = t('category_rail_all');

  return (
    <aside className="gp-cat-rail" aria-label={t('category_rail_heading')}>
      <div className="gp-cat-rail__heading">{t('category_rail_heading')}</div>
      <button
        type="button"
        className="gp-cat-rail__item"
        aria-pressed={active === ''}
        onClick={() => onChange('')}
        style={{ paddingLeft: 8 }}
      >
        <span>{allLabel}</span>
        <span className="gp-cat-rail__count">{totalCount}</span>
      </button>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className="gp-cat-rail__item"
          aria-pressed={active === it.id}
          onClick={() => onChange(it.id)}
          style={{ paddingLeft: 8 + it.depth * 12 }}
          title={it.id}
        >
          <span>{it.label}</span>
          <span className="gp-cat-rail__count">{it.count}</span>
        </button>
      ))}
    </aside>
  );
}

export function useCategoryItems(entities: readonly Entity[]): CategoryItem[] {
  return useMemo(() => buildCategoryItems(entities), [entities]);
}

interface CategoryPillsProps {
  items: readonly CategoryItem[];
  active: string;
  onChange: (id: string) => void;
  maxDepth?: number;
}

/** Mobile compact horizontal pill bar — shown above entity grid. */
export function CategoryPills({ items, active, onChange, maxDepth = 2 }: CategoryPillsProps) {
  const t = useTranslations('library');
  const visible = items.filter((it) => it.depth <= maxDepth);
  return (
    <div className="gp-cat-pills" role="tablist">
      <button
        type="button"
        className="gp-cat-pill"
        role="tab"
        aria-selected={active === ''}
        onClick={() => onChange('')}
      >
        {t('category_rail_all')}
      </button>
      {visible.map((it) => (
        <button
          key={it.id}
          type="button"
          className="gp-cat-pill"
          role="tab"
          aria-selected={active === it.id}
          onClick={() => onChange(it.id)}
        >
          {it.label}
          <span className="gp-cat-pill__count">{it.count}</span>
        </button>
      ))}
    </div>
  );
}
