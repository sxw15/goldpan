'use client';

import type { CitedEntity } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';

interface QueryResultProps {
  result: {
    answer: string;
    confidence: 'high' | 'medium' | 'low' | 'no_data';
    citedEntities?: CitedEntity[];
  };
  onEntitySelect: (entity: CitedEntity) => void;
}

const CONFIDENCE_KEYS = {
  high: 'query_confidence_high',
  medium: 'query_confidence_medium',
  low: 'query_confidence_low',
  no_data: 'query_confidence_no_data',
} as const;

/**
 * Build the uppercase chip prefix from the entity's primary category. Uses the
 * first segment of the first categoryPath (e.g. "source/article" → "SOURCE")
 * so chips visually match the design's typed citations. Falls back to a
 * generic label when an entity has no category.
 */
function chipPrefix(entity: CitedEntity, fallback: string): string {
  const first = entity.categoryPaths[0];
  if (!first) return fallback;
  const head = first.split('/')[0];
  return head ? head.toUpperCase() : fallback;
}

export function QueryResultCard({ result, onEntitySelect }: QueryResultProps) {
  const t = useTranslations('chat');
  const confidenceLabel = t(CONFIDENCE_KEYS[result.confidence]);
  const entities = result.citedEntities ?? [];

  return (
    <div className={`gp-query-card gp-query-card--${result.confidence}`}>
      <div className="gp-query-card__head">
        <span className="gp-query-card__title">{t('query_card_title')}</span>
        <span
          className={`gp-query-card__confidence gp-query-card__confidence--${result.confidence}`}
        >
          <span className="gp-query-card__confidence-dot" aria-hidden />
          {confidenceLabel}
        </span>
      </div>
      <div className="gp-query-card__answer">{result.answer}</div>
      {entities.length > 0 && (
        <div className="gp-query-card__chips">
          {entities.map((e) => (
            <button
              type="button"
              key={e.id}
              className="gp-chip"
              data-variant="cite"
              title={e.categoryPaths.join(' / ')}
              onClick={() => onEntitySelect(e)}
            >
              <span className="gp-chip__type">
                {chipPrefix(e, t('query_citation_source_fallback'))}
              </span>
              <span className="gp-chip__name">{e.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
