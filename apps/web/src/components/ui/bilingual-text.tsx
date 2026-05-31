'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

/**
 * Show `translated` text by default and let the user reveal `original` on
 * demand. When `translated` is missing / empty / identical to original, falls
 * back to rendering the original directly with no toggle. This lets call
 * sites just pass both fields and let the component decide whether the toggle
 * makes sense at all.
 *
 * Used for fact / opinion / entity description / relation description /
 * summary surfaces produced by the optional `translating` pipeline step.
 */
export function BilingualText({
  original,
  translated,
  className,
  as = 'span',
}: {
  original: string | null | undefined;
  translated: string | null | undefined;
  className?: string;
  /**
   * Wrapping tag — defaults to span, but list-like callers may want a div /
   * paragraph so the original block (rendered below the main text) sits in
   * the right layout context.
   */
  as?: 'span' | 'div' | 'p';
}) {
  const t = useTranslations('bilingual');
  const [showOriginal, setShowOriginal] = useState(false);

  const safeOriginal = (original ?? '').trim();
  const safeTranslated = (translated ?? '').trim();
  const hasTranslation = safeTranslated.length > 0 && safeTranslated !== safeOriginal;

  const Tag = as;

  if (!hasTranslation) {
    return <Tag className={className}>{safeOriginal || original || ''}</Tag>;
  }

  return (
    <Tag className={`gp-bilingual ${className ?? ''}`.trim()}>
      <span className="gp-bilingual__main">{safeTranslated}</span>{' '}
      <button
        type="button"
        className="gp-bilingual__toggle"
        aria-pressed={showOriginal}
        aria-label={showOriginal ? t('hide_original_aria') : t('show_original_aria')}
        onClick={() => setShowOriginal((v) => !v)}
      >
        {showOriginal ? t('hide_original') : t('show_original')}
      </button>
      {showOriginal && (
        <span className="gp-bilingual__original">
          <span className="gp-bilingual__original-label">{t('original_label')}</span>
          <span className="gp-bilingual__original-text">{safeOriginal}</span>
        </span>
      )}
    </Tag>
  );
}
