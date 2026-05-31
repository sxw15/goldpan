'use client';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { useFetchOnIdChange } from '@/hooks/use-fetch-on-id-change';
import { getBrowserApiClient } from '@/lib/api-client-browser';

const fetchConnections = (sinceMs: number, signal: AbortSignal) =>
  getBrowserApiClient().getDigestConnections({ since: sinceMs, limit: 5 }, signal);

export function ConnectionsSection({
  sinceMs,
  onOpenEntity,
}: {
  sinceMs: number;
  onOpenEntity: (id: number) => void;
}) {
  const t = useTranslations('digest');
  const { state } = useFetchOnIdChange(sinceMs, fetchConnections);

  // Operator hint — UI placeholder already surfaces the error to the user.
  useEffect(() => {
    if (state.status === 'error') {
      console.warn('ConnectionsSection fetch failed', state.error);
    }
  }, [state]);

  // 顺序:loading 永远 null (防 layout shift) → error 显示 placeholder
  // (operator 排错可见) → items < 3 视觉过稀 null。error 必须在 items
  // 之前判:catch 里把 items 重置为 [] 满足 length<3,会让 error 永远不可见。
  if (state.status === 'loading') return null;
  if (state.status === 'error') {
    return (
      <section
        className="gp-digest-section gp-digest-section--connections"
        aria-labelledby="digest-connections-title"
        aria-live="polite"
      >
        <h2 id="digest-connections-title" className="gp-digest-section__title">
          {t('section_connections_title')}
        </h2>
        <p className="gp-digest-section__error" role="status">
          {t('section_connections_error')}
        </p>
      </section>
    );
  }
  const items = state.data.data;
  if (items.length < 3) return null;

  return (
    <section
      className="gp-digest-section gp-digest-section--connections"
      aria-labelledby="digest-connections-title"
    >
      <h2 id="digest-connections-title" className="gp-digest-section__title">
        {t('section_connections_title')}
      </h2>
      <ul className="gp-digest-section__list">
        {items.map((c) => (
          <li key={c.id} className="gp-connection-item">
            <button
              type="button"
              className="gp-connection-item__entity"
              onClick={() => onOpenEntity(c.source.id)}
            >
              {c.source.name}
            </button>
            <span className="gp-connection-item__separator" aria-hidden>
              ↔
            </span>
            <button
              type="button"
              className="gp-connection-item__entity"
              onClick={() => onOpenEntity(c.target.id)}
            >
              {c.target.name}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
