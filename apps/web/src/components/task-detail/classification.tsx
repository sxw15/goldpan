'use client';

import type { ProcessingResultClassification } from '@/types/processing-result';

interface ClassificationStripProps {
  classification: ProcessingResultClassification;
  categoryLabel: string;
  keywordsLabel: string;
}

export function ClassificationStrip({
  classification,
  categoryLabel,
  keywordsLabel,
}: ClassificationStripProps) {
  const hasCategory = !!classification.categoryPath;
  const keywords = classification.keywords ?? [];
  if (!hasCategory && keywords.length === 0) return null;

  return (
    <div className="gp-td-class">
      {hasCategory && (
        <div className="gp-td-class__row">
          <div className="gp-td-class__label">{categoryLabel}</div>
          <div className="gp-td-class__value">
            <span className="gp-td-class__path">{classification.categoryPath}</span>
          </div>
        </div>
      )}
      {keywords.length > 0 && (
        <div className="gp-td-class__row">
          <div className="gp-td-class__label">{keywordsLabel}</div>
          <div className="gp-td-class__value">
            {keywords.map((k) => (
              <span key={k} className="gp-td-class__chip">
                {k}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
