'use client';

import type { ReactNode } from 'react';
import { safeHref } from '@/lib/url';

interface HeroProps {
  /** Eyebrow label above the title (e.g. "成果单 · TASK #6"). */
  eyebrow: string;
  title: string;
  sourceLabel?: string;
  sourceUrl?: string | null;
  meta?: Array<{ label: string; value: string }>;
  toolbox?: ReactNode;
}

export function Hero({ eyebrow, title, sourceLabel, sourceUrl, meta = [], toolbox }: HeroProps) {
  const href = sourceUrl ? safeHref(sourceUrl) : null;
  return (
    <header className="gp-hero">
      <div className="gp-hero__main">
        <div className="gp-hero__eyebrow">{eyebrow}</div>
        <h1 className="gp-hero__title">{title}</h1>
        {sourceUrl && (
          <p className="gp-hero__source">
            {sourceLabel ? <span className="gp-hero__source-label">{sourceLabel}</span> : null}
            {href && href !== '#' ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {sourceUrl}
              </a>
            ) : (
              <span>{sourceUrl}</span>
            )}
          </p>
        )}
        {meta.length > 0 && (
          <dl className="gp-hero__meta">
            {meta.map((m) => (
              <div key={m.label}>
                <dt>{m.label}</dt>
                <dd>{m.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {toolbox ? <div className="gp-hero__toolbox">{toolbox}</div> : null}
    </header>
  );
}
