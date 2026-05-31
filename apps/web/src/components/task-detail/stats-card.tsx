'use client';

import type { ProcessingResultStats } from '@/types/processing-result';

interface StatsCardProps {
  stats: ProcessingResultStats;
  labels: {
    title: string;
    knowledgeUnit: string;
    sub: (vars: { extracted: number; rate: number; skipped: number }) => string;
    extracted: string;
    skipped: string;
    droppedUnassigned: string;
    quarantined: string;
    verifierRejected: string;
  };
}

export function StatsCard({ stats, labels }: StatsCardProps) {
  const acceptRate = stats.extracted ? Math.round((stats.accepted / stats.extracted) * 100) : 0;
  const minor: Array<{ key: keyof ProcessingResultStats; label: string }> = [
    { key: 'extracted', label: labels.extracted },
    { key: 'skipped', label: labels.skipped },
    { key: 'droppedUnassigned', label: labels.droppedUnassigned },
    { key: 'quarantined', label: labels.quarantined },
    { key: 'verifierRejected', label: labels.verifierRejected },
  ];

  return (
    <div className="gp-td-stats">
      <div className="gp-td-stats__hero">
        <div className="gp-td-stats__hero-label">{labels.title}</div>
        <div className="gp-td-stats__hero-num">
          {stats.accepted}
          <small>{labels.knowledgeUnit}</small>
        </div>
        <div className="gp-td-stats__hero-sub">
          {labels.sub({ extracted: stats.extracted, rate: acceptRate, skipped: stats.skipped })}
        </div>
      </div>
      <div className="gp-td-stats__minor">
        {minor.map((c) => {
          const value = stats[c.key];
          return (
            <div
              key={c.key}
              className={`gp-td-stats__cell${value === 0 ? ' gp-td-stats__cell--zero' : ''}`}
            >
              <span>{c.label}</span>
              <b>{value}</b>
            </div>
          );
        })}
      </div>
    </div>
  );
}
