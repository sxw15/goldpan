'use client';
import type { DigestPeriod } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';

interface StatsItem {
  captures: number;
  findings: number;
  thoughts: number;
  entities: number;
  period: DigestPeriod;
}

export function StatsSection({ captures, findings, thoughts, entities, period }: StatsItem) {
  const t = useTranslations('digest');
  const periodLabel = t(`section_period_${period}`);
  const cell = (label: string, value: number) => (
    <div className="gp-digest-stats__item">
      <dt className="gp-digest-stats__label">{label}</dt>
      <dd className={`gp-digest-stats__value${value === 0 ? ' gp-digest-stats__value--zero' : ''}`}>
        {value}
      </dd>
    </div>
  );
  return (
    <section
      className="gp-digest-section gp-digest-section--stats"
      aria-labelledby="digest-stats-title"
    >
      <div className="gp-digest-section__head">
        <h2 id="digest-stats-title" className="gp-digest-section__title">
          {t('section_stats_title', { period: periodLabel })}
        </h2>
      </div>
      <dl className="gp-digest-stats">
        {cell(t('stats_label_captures'), captures)}
        {cell(t('stats_label_findings'), findings)}
        {cell(t('stats_label_thoughts'), thoughts)}
        {cell(t('stats_label_entities'), entities)}
      </dl>
    </section>
  );
}
