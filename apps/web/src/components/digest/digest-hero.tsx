'use client';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

export function DigestHero({
  text,
  status,
  channel,
}: {
  text: string;
  status: 'pending' | 'complete' | 'fallback';
  /** When provided, the failed-state CTA links to /settings?channel=… for LLM key config. */
  channel?: string;
}) {
  const t = useTranslations('digest');
  const failed = status === 'fallback' && !text.trim();
  if (!failed && !text.trim()) return null;

  const statusLabel =
    status === 'pending'
      ? t('ai_hero_status_pending')
      : status === 'fallback'
        ? t('ai_hero_status_fallback')
        : t('ai_hero_status_complete');

  return (
    <section
      className={`gp-digest-hero${failed ? ' gp-digest-hero--failed' : ''}`}
      aria-label={t('hero_aria_label')}
    >
      <div className="gp-digest-hero__h">
        {t('ai_hero_title')}
        <span className="gp-digest-hero__pill">{statusLabel}</span>
      </div>
      <p className="gp-digest-hero__text">{failed ? t('ai_hero_failed_body') : text}</p>
      {failed && (
        <Link
          href={{ pathname: '/settings', query: channel ? { channel } : undefined }}
          className="gp-digest-hero__cta"
        >
          {t('ai_hero_cta_settings')}
        </Link>
      )}
    </section>
  );
}
