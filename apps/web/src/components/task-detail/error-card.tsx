'use client';

import type { ReactNode } from 'react';

interface ErrorCardProps {
  title: string;
  message: string;
  hint?: ReactNode;
  primaryCta: ReactNode;
  secondaryCtas?: ReactNode;
  /** Right-aligned destructive (e.g. delete-task) action. */
  endCta?: ReactNode;
}

export function ErrorCard({
  title,
  message,
  hint,
  primaryCta,
  secondaryCtas,
  endCta,
}: ErrorCardProps) {
  return (
    <div className="gp-td-error-card">
      <h3>{title}</h3>
      <p className="gp-td-error-card__msg">{message}</p>
      {hint && <div className="gp-td-error-card__hint">{hint}</div>}
      <div className="gp-td-error-card__cta">
        {primaryCta}
        {secondaryCtas}
        {endCta && <span className="gp-td-error-card__cta--end">{endCta}</span>}
      </div>
    </div>
  );
}
