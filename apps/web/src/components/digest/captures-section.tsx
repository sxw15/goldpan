'use client';
import type { DigestPeriod } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { StateEmpty } from '@/components/state/state-empty';
import { useTz } from '@/components/tz-provider';
import { formatRelativeTime } from '@/lib/format';

interface CaptureItem {
  id: number;
  title: string;
  url: string;
  createdAt: number;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function CapturesSection({
  items,
  hasMore,
  hiddenCount,
  onOpenSource,
  period,
}: {
  items: CaptureItem[];
  hasMore: boolean;
  hiddenCount: number;
  onOpenSource?: (id: number) => void;
  period: DigestPeriod;
}) {
  const t = useTranslations('digest');
  const tTime = useTranslations('time');
  const tz = useTz();
  const periodLabel = t(`section_period_${period}`);
  if (items.length === 0) {
    return (
      <section
        className="gp-digest-section gp-digest-section--captures"
        aria-labelledby="digest-captures-title"
      >
        <div className="gp-digest-section__head">
          <h2 id="digest-captures-title" className="gp-digest-section__title">
            {t('section_captures_title', { period: periodLabel })}
          </h2>
        </div>
        <StateEmpty title={t('section_captures_empty', { period: periodLabel })} />
      </section>
    );
  }
  return (
    <section
      className="gp-digest-section gp-digest-section--captures"
      aria-labelledby="digest-captures-title"
    >
      <div className="gp-digest-section__head">
        <h2 id="digest-captures-title" className="gp-digest-section__title">
          {t('section_captures_title', { period: periodLabel })}
          <span className="gp-digest-section__count">
            {t('section_count_label', { n: items.length })}
          </span>
        </h2>
      </div>
      <ul className="gp-digest-section__list gp-digest-section__list--captures">
        {items.map((it) => {
          const host = hostnameOf(it.url) ?? t('section_captures_meta_unknown_source');
          const iso = new Date(it.createdAt).toISOString();
          const time = formatRelativeTime(it.createdAt, tTime, tz);
          return (
            <li key={it.id}>
              {onOpenSource ? (
                <button type="button" className="gp-digest-cap" onClick={() => onOpenSource(it.id)}>
                  <span className="gp-digest-cap__l">
                    <span className="gp-digest-cap__title">{it.title}</span>
                    <span className="gp-digest-cap__meta">
                      <span>{host}</span>
                    </span>
                  </span>
                  <time className="gp-digest-cap__time" dateTime={iso}>
                    {time}
                  </time>
                </button>
              ) : (
                <a
                  href={it.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="gp-digest-cap__link"
                >
                  <span className="gp-digest-cap__l">
                    <span className="gp-digest-cap__title">{it.title}</span>
                    <span className="gp-digest-cap__meta">
                      <span>{host}</span>
                    </span>
                  </span>
                  <time className="gp-digest-cap__time" dateTime={iso}>
                    {time}
                  </time>
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {hasMore && hiddenCount > 0 && (
        <p className="gp-digest-section__more-footer">
          {t('section_more_footer', { n: hiddenCount })}
        </p>
      )}
    </section>
  );
}
