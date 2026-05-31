'use client';
import type { DigestPeriod } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { StateEmpty } from '@/components/state/state-empty';
import { useTz } from '@/components/tz-provider';
import { formatRelativeTime } from '@/lib/format';

interface ThoughtItem {
  id: number;
  text: string;
  createdAt: number;
}

export function ThoughtsSection({
  items,
  hasMore,
  hiddenCount,
  onOpenSource,
  period,
}: {
  items: ThoughtItem[];
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
        className="gp-digest-section gp-digest-section--thoughts"
        aria-labelledby="digest-thoughts-title"
      >
        <div className="gp-digest-section__head">
          <h2 id="digest-thoughts-title" className="gp-digest-section__title">
            {t('section_thoughts_title', { period: periodLabel })}
          </h2>
        </div>
        <StateEmpty title={t('section_thoughts_empty', { period: periodLabel })} />
      </section>
    );
  }
  return (
    <section
      className="gp-digest-section gp-digest-section--thoughts"
      aria-labelledby="digest-thoughts-title"
    >
      <div className="gp-digest-section__head">
        <h2 id="digest-thoughts-title" className="gp-digest-section__title">
          {t('section_thoughts_title', { period: periodLabel })}
          <span className="gp-digest-section__count">
            {t('section_count_label', { n: items.length })}
          </span>
        </h2>
      </div>
      <ul className="gp-digest-section__list gp-digest-section__list--thoughts">
        {items.map((it) => {
          const iso = new Date(it.createdAt).toISOString();
          const time = formatRelativeTime(it.createdAt, tTime, tz);
          return (
            <li key={it.id}>
              {onOpenSource ? (
                <button
                  type="button"
                  className="gp-digest-thought"
                  onClick={() => onOpenSource(it.id)}
                >
                  <span className="gp-digest-thought__text gp-digest-section__item-title">
                    {it.text}
                  </span>
                  <time className="gp-digest-thought__time" dateTime={iso}>
                    {time}
                  </time>
                </button>
              ) : (
                <span
                  className="gp-digest-thought gp-digest-thought--static"
                  title={t('share_item_hint')}
                >
                  <span className="gp-digest-thought__text gp-digest-section__item-title">
                    {it.text}
                  </span>
                  <time className="gp-digest-thought__time" dateTime={iso}>
                    {time}
                  </time>
                </span>
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
