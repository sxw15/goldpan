'use client';

import type { SourceViewDetail } from '@goldpan/web-sdk';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { useTz } from '@/components/tz-provider';
import { useFetchOnIdChange } from '@/hooks/use-fetch-on-id-change';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import { formatDateOnly } from '@/lib/format';
import { isKnownSourceOrigin, sourceOriginI18nKey } from '@/lib/task-display';
import { safeHref } from '../../../lib/url';
import { useConfirm } from '../../confirm-provider';
import { StateEmpty } from '../../state/state-empty';
import { StateError } from '../../state/state-error';
import { StateLoading } from '../../state/state-loading';
import { BilingualText } from '../../ui/bilingual-text';
import type { InspectorPayload, PayloadAction, PayloadCapabilitySet } from './types';

const DISCARDABLE_STATUSES = ['confirmed', 'confirmed_empty'] as const;

const fetchSourceView = (id: number, signal: AbortSignal) =>
  getBrowserApiClient().getSourceView(id, signal);

interface SourceViewPayloadProps {
  id: number;
  onTitleReady: (title: string) => void;
  onNavigateEntity: (next: InspectorPayload) => void;
  /**
   * SourceViewPayload is the full source-detail view (rendered for inspector
   * kind=source). It needs a management path (discard); without this prop
   * the discard affordance disappears in shells whose dispatcher omits it.
   */
  onAction?: (action: PayloadAction) => Promise<void>;
  capabilities?: PayloadCapabilitySet;
}

export function SourceViewPayload({
  id,
  onTitleReady,
  onNavigateEntity,
  onAction,
  capabilities,
}: SourceViewPayloadProps) {
  const tSource = useTranslations('source_view_payload');
  const tLib = useTranslations('library');
  const tCommon = useTranslations('common');
  const tStatus = useTranslations('source.status');
  const tz = useTz();
  const confirm = useConfirm();
  // optimistic — flip our own chip on discard without awaiting a refetch.
  const [override, setOverride] = useState<SourceViewDetail | null>(null);
  const [discardPending, setDiscardPending] = useState(false);
  const [discardError, setDiscardError] = useState<Error | null>(null);

  const { state, retry } = useFetchOnIdChange(id, fetchSourceView, {
    onReady: (d) => {
      const title = d.source.title ?? d.source.originalUrl ?? tLib('source_title_fallback', { id });
      onTitleReady(title);
      setOverride(null);
    },
  });
  const detail = override ?? (state.status === 'ready' ? state.data : null);

  const handleDiscard = useCallback(async () => {
    if (!onAction || !detail) return;
    const confirmed = await confirm({
      message: tLib('source_discard_confirm'),
      confirmLabel: tCommon('discard'),
      danger: true,
    });
    if (!confirmed) return;
    setDiscardPending(true);
    setDiscardError(null);
    try {
      await onAction({ type: 'discardSource', id: detail.source.id });
      setOverride({ ...detail, source: { ...detail.source, status: 'discarded' } });
    } catch (err) {
      setDiscardError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setDiscardPending(false);
    }
  }, [confirm, detail, onAction, tCommon, tLib]);

  if (state.status === 'error') return <StateError error={state.error} onRetry={retry} />;
  if (!detail) return <StateLoading />;

  const { source, entities, categoryPaths, tags } = detail;
  const isEmpty = entities.length === 0 && tags.length === 0 && categoryPaths.length === 0;
  const canDiscard =
    (DISCARDABLE_STATUSES as readonly string[]).includes(source.status) &&
    Boolean(onAction) &&
    (capabilities?.has('discardSource') ?? false);

  const discardAction = canDiscard ? (
    <div className="gp-source-view-payload__actions">
      <button
        type="button"
        className="gp-btn"
        data-variant="danger"
        data-size="sm"
        onClick={handleDiscard}
        disabled={discardPending}
      >
        {tLib('source_action_discard')}
      </button>
      {discardError && (
        <p role="alert" className="gp-source-view-payload__discard-error">
          {tLib('source_discard_failed')}
        </p>
      )}
    </div>
  ) : null;

  if (isEmpty) {
    return (
      <div className="gp-source-view-payload">
        <header className="gp-source-view-payload__source-header">
          <div className="gp-source-view-payload__source-meta">
            <span className={`gp-source-status-chip gp-source-status-chip--${source.status}`}>
              {tStatus(source.status)}
            </span>
          </div>
          {source.originalUrl && (
            <a
              className="gp-source-view-payload__source-link"
              href={safeHref(source.originalUrl)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {source.originalUrl}
            </a>
          )}
        </header>
        <StateEmpty title={tSource('empty_title')} description={tSource('empty_description')} />
        {discardAction}
      </div>
    );
  }

  return (
    <div className="gp-source-view-payload">
      <header className="gp-source-view-payload__source-header">
        {/* Title rendered by InspectorHeader (onTitleReady) — do not duplicate here. */}
        <div className="gp-source-view-payload__source-meta">
          <span className={`gp-source-status-chip gp-source-status-chip--${source.status}`}>
            {tStatus(source.status)}
          </span>
          <span className="gp-source-view-payload__meta-item">
            <span className="gp-source-view-payload__meta-label">{tLib('source_meta_origin')}</span>
            <span className="gp-source-view-payload__meta-value">
              {isKnownSourceOrigin(source.origin)
                ? tLib(sourceOriginI18nKey(source.origin))
                : source.origin}
            </span>
          </span>
          <span className="gp-source-view-payload__meta-item">
            <span className="gp-source-view-payload__meta-label">
              {tLib('source_meta_created_at')}
            </span>
            <span className="gp-source-view-payload__meta-value">
              {formatDateOnly(source.createdAt, tz)}
            </span>
          </span>
        </div>
        {source.originalUrl && (
          <a
            className="gp-source-view-payload__source-link"
            href={safeHref(source.originalUrl)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {source.originalUrl}
          </a>
        )}
      </header>

      {tags.length > 0 && (
        <section className="gp-source-view-payload__tags-section">
          <h4>{tSource('tags_heading')}</h4>
          <ul className="gp-source-view-payload__tags">
            {tags.map((tag) => (
              <li key={tag}>{tag}</li>
            ))}
          </ul>
        </section>
      )}

      {categoryPaths.length > 0 && (
        <section className="gp-source-view-payload__categories">
          <h4>{tSource('categories_heading')}</h4>
          <ul>
            {categoryPaths.map((cp) => (
              <li key={cp}>{cp}</li>
            ))}
          </ul>
        </section>
      )}

      {entities.length > 0 && (
        <section className="gp-source-view-payload__knowledge">
          <h4>{tSource('knowledge_heading')}</h4>
          {entities.map((grp) => (
            <div key={grp.entityId} className="gp-source-view-payload__entity-group">
              <button
                type="button"
                className="gp-source-view-payload__entity-name"
                onClick={() => onNavigateEntity({ kind: 'entity', id: grp.entityId })}
              >
                {grp.entityName}
              </button>
              <ul className="gp-source-view-payload__points-list">
                {grp.points.map((p) => (
                  <li
                    key={p.id}
                    className={`gp-source-view-payload__point--${p.type === 'fact' ? 'fact' : 'opinion'}`}
                  >
                    <BilingualText original={p.content} translated={p.contentTranslated} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
      {discardAction}
    </div>
  );
}
