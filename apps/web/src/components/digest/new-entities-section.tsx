'use client';
import type { DigestPeriod } from '@goldpan/web-sdk';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { StateEmpty } from '@/components/state/state-empty';

interface EntityItem {
  id: number;
  name: string;
  description: string | null;
  createdAt: number;
}

export function NewEntitiesSection({
  items,
  hasMore,
  hiddenCount,
  onOpenEntity,
  period,
}: {
  items: EntityItem[];
  hasMore: boolean;
  hiddenCount: number;
  onOpenEntity?: (id: number) => void;
  period: DigestPeriod;
}) {
  const t = useTranslations('digest');
  const periodLabel = t(`section_period_${period}`);
  if (items.length === 0) {
    return (
      <section
        className="gp-digest-section gp-digest-section--entities"
        aria-labelledby="digest-entities-title"
      >
        <div className="gp-digest-section__head">
          <h2 id="digest-entities-title" className="gp-digest-section__title">
            {t('section_entities_title', { period: periodLabel })}
          </h2>
        </div>
        <StateEmpty title={t('section_entities_empty', { period: periodLabel })} />
      </section>
    );
  }
  return (
    <section
      className="gp-digest-section gp-digest-section--entities"
      aria-labelledby="digest-entities-title"
    >
      <div className="gp-digest-section__head">
        <h2 id="digest-entities-title" className="gp-digest-section__title">
          {t('section_entities_title', { period: periodLabel })}
          <span className="gp-digest-section__count">
            {t('section_count_label', { n: items.length })}
            {hasMore && hiddenCount > 0
              ? ` · ${t('section_count_hidden_more', { n: hiddenCount })}`
              : ''}
          </span>
        </h2>
        {hasMore && hiddenCount > 0 && onOpenEntity && (
          // No client-side fetch endpoint to load the truncated tail — server
          // already trimmed the snapshot's `items[]` to the rendered set, so
          // expanding inline cannot show more. Deep-link to the library where
          // the full list lives instead.
          <Link href={{ pathname: '/library/entities' }} className="gp-digest-section__more-button">
            {t('show_all')}
          </Link>
        )}
      </div>
      <div className="gp-digest-egrid">
        {items.map((it) => {
          const inner = (
            <>
              <span className="gp-digest-echip__dot" aria-hidden="true" />
              <span className="gp-digest-section__item-title gp-digest-echip__name">{it.name}</span>
            </>
          );
          if (onOpenEntity) {
            return (
              <button
                type="button"
                key={it.id}
                className="gp-digest-echip"
                onClick={() => onOpenEntity(it.id)}
                title={it.description ?? undefined}
              >
                {inner}
              </button>
            );
          }
          return (
            <span
              key={it.id}
              className="gp-digest-echip gp-digest-echip--static"
              title={t('share_item_hint')}
            >
              {inner}
            </span>
          );
        })}
      </div>
    </section>
  );
}
