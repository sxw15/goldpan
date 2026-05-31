'use client';
import type { DigestPeriod } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { StateEmpty } from '@/components/state/state-empty';
import { useTz } from '@/components/tz-provider';
import { formatRelativeTime } from '@/lib/format';

interface TrackingItem {
  id: number;
  ruleId: number | null;
  title: string;
  url: string;
  createdAt: number;
}

export function TrackingFindingsSection({
  items,
  hasMore,
  hiddenCount,
  onOpenSource,
  period,
}: {
  items: TrackingItem[];
  hasMore: boolean;
  hiddenCount: number;
  onOpenSource?: (id: number) => void;
  period: DigestPeriod;
}) {
  const t = useTranslations('digest');
  // formatRelativeTime 读取 `time.*` keys (just_now / minutes_ago / ...);
  // 必须用独立 namespace,否则会 missing-message warn + fallback to key 字面量。
  const tTime = useTranslations('time');
  const tz = useTz();
  const periodLabel = t(`section_period_${period}`);
  if (items.length === 0) {
    return (
      <section
        className="gp-digest-section gp-digest-section--tracking"
        aria-labelledby="digest-tracking-title"
      >
        <div className="gp-digest-section__head">
          <h2 id="digest-tracking-title" className="gp-digest-section__title">
            {t('section_tracking_title', { period: periodLabel })}
          </h2>
        </div>
        <StateEmpty title={t('section_tracking_empty', { period: periodLabel })} />
      </section>
    );
  }
  return (
    <section
      className="gp-digest-section gp-digest-section--tracking"
      aria-labelledby="digest-tracking-title"
    >
      <div className="gp-digest-section__head">
        <h2 id="digest-tracking-title" className="gp-digest-section__title">
          {t('section_tracking_title', { period: periodLabel })}
          <span className="gp-digest-section__count">
            {t('section_count_label', { n: items.length })}
          </span>
        </h2>
      </div>
      <ul className="gp-digest-section__list gp-digest-section__list--tracking">
        {items.map((it) => {
          const iso = new Date(it.createdAt).toISOString();
          const time = formatRelativeTime(it.createdAt, tTime, tz);
          return (
            <li key={it.id}>
              {onOpenSource ? (
                <button
                  type="button"
                  className="gp-digest-track"
                  onClick={() => onOpenSource(it.id)}
                >
                  <span className="gp-digest-track__title gp-digest-section__item-title">
                    {it.title}
                  </span>
                  <time className="gp-digest-track__time" dateTime={iso}>
                    {time}
                  </time>
                </button>
              ) : (
                // rel: noopener 防 window.opener 反向引用;noreferrer 防 share URL
                // (带 sig)经 referer 泄露。
                <a
                  href={it.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="gp-digest-track__link"
                >
                  <span className="gp-digest-track__title gp-digest-section__item-title">
                    {it.title}
                  </span>
                  <time className="gp-digest-track__time" dateTime={iso}>
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
