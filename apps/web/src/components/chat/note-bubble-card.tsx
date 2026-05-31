'use client';

import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { type RetryState, retryAction } from '@/actions/retry';
import { useTaskPolling } from '@/lib/polling';
import { localizeErrorKind } from '@/lib/task-error';
import type { ProcessingResult } from '@/types/processing-result';

interface NoteBubbleCardProps {
  taskId: number;
}

/**
 * Aggregate hashtag-style tags from every opinion point across all entities.
 * Tags can repeat across points (the LLM is allowed to reuse a label like
 * `趋势判断` on multiple opinions in the same submission), so we dedupe
 * case-insensitively while preserving the original casing of the first
 * occurrence — that mirrors how `extracting.ts` canonicalizes them.
 */
function collectTags(result: ProcessingResult): string[] {
  const seen = new Map<string, string>();
  for (const entity of result.entities) {
    for (const point of entity.newOpinionPoints) {
      if (!point.tags) continue;
      for (const tag of point.tags) {
        const key = tag.toLowerCase();
        if (!seen.has(key)) seen.set(key, tag);
      }
    }
  }
  return Array.from(seen.values());
}

function chipPrefix(categoryPath: string | undefined, fallback: string): string {
  if (!categoryPath) return fallback;
  const head = categoryPath.split('/')[0];
  return head ? head.toUpperCase() : fallback;
}

export function NoteBubbleCard({ taskId }: NoteBubbleCardProps) {
  const tNote = useTranslations('chat.note_bubble');
  const tBubble = useTranslations('chat.task_bubble');
  const tCta = useTranslations('chat.task_bubble.cta');
  const tPolling = useTranslations('polling');
  const tCommon = useTranslations('common');
  // Error messages localize from `error.kind` (same source as task detail) so
  // the bubble never shows the server's raw English `error.message`.
  const tTaskErr = useTranslations('task_detail');

  // Same restart-on-retry pattern as TaskBubbleCard — `record_thought` shares
  // the pipeline with regular submits, so retries can rerun cleanly.
  const [restartKey, setRestartKey] = useState(0);

  const {
    data,
    error: pollError,
    notFound,
  } = useTaskPolling({
    taskId,
    enabled: true,
    intervalMs: 3000,
    restartKey,
    t: (key) => tPolling(key),
  });

  const [retryState, retryFormAction, isRetrying] = useActionState<RetryState, FormData>(
    async (prev, formData) => {
      const result = await retryAction(prev, formData);
      if (result.success) setRestartKey((k) => k + 1);
      return result;
    },
    {},
  );

  const status = data?.status ?? 'pending';
  const result: ProcessingResult | null =
    data?.status === 'done' ? (data.result as unknown as ProcessingResult) : null;

  const quote = result?.noteQuote ?? '';
  const entities = result?.entities ?? [];
  const tags = result ? collectTags(result) : [];
  const errorMsg = data?.status === 'error' ? localizeErrorKind(data.error.kind, tTaskErr) : null;
  const errorRetryable = data?.status === 'error' ? data.error.retryable : true;

  const title =
    status === 'error'
      ? tNote('title_error')
      : status === 'done'
        ? tNote('title')
        : tNote('title_processing');

  if (notFound) {
    // Note's task was deleted — calm muted tombstone, not the red error bubble.
    return (
      <div
        className="gp-note-bubble"
        style={{ padding: '12px 14px', color: 'var(--gp-ink-muted)', fontSize: 13 }}
      >
        {tPolling('task_deleted')}
      </div>
    );
  }

  return (
    <div className={`gp-note-bubble gp-note-bubble--${status}`}>
      <div className="gp-note-bubble__head">
        <span className="gp-note-bubble__title">{title}</span>
      </div>

      {(status === 'pending' || status === 'processing') && (
        <div className="gp-note-bubble__progress" aria-hidden>
          <div className="gp-note-bubble__progress-fill" />
        </div>
      )}

      {quote && (
        <blockquote className="gp-note-bubble__quote">
          <p>{quote}</p>
        </blockquote>
      )}

      {status === 'done' && (
        <>
          <div className="gp-note-bubble__row">
            <span className="gp-note-bubble__row-label">{tNote('related_label')}</span>
            <div className="gp-note-bubble__row-chips">
              {entities.length === 0 ? (
                <span className="gp-note-bubble__empty">{tNote('no_entities')}</span>
              ) : (
                entities.map((e) => {
                  const href = e.entityId ? `/library?focus=${e.entityId}&kind=entity` : '/library';
                  return (
                    <Link
                      key={e.entityKey}
                      href={href}
                      className="gp-chip"
                      data-variant="cite"
                      title={e.categoryPath}
                    >
                      <span className="gp-chip__type">{chipPrefix(e.categoryPath, 'ENTITY')}</span>
                      <span className="gp-chip__name">{e.entityName}</span>
                    </Link>
                  );
                })
              )}
            </div>
          </div>

          <div className="gp-note-bubble__row">
            <span className="gp-note-bubble__row-label">{tNote('tags_label')}</span>
            <div className="gp-note-bubble__row-chips">
              {tags.length === 0 ? (
                <span className="gp-note-bubble__empty">{tNote('no_tags')}</span>
              ) : (
                tags.map((t) => (
                  <span key={t} className="gp-note-bubble__tag">
                    {tNote('tag_prefix')}
                    {t}
                  </span>
                ))
              )}
            </div>
          </div>
        </>
      )}

      {status === 'error' && (
        <>
          {errorMsg && <div className="gp-note-bubble__err-msg">{errorMsg}</div>}
          <div className="gp-note-bubble__cta">
            {errorRetryable && (
              <form action={retryFormAction}>
                <input type="hidden" name="taskId" value={taskId} />
                <button
                  type="submit"
                  disabled={isRetrying}
                  className="gp-btn"
                  data-variant="primary"
                  data-size="sm"
                >
                  <RefreshCw size={11} aria-hidden />
                  {isRetrying ? tCommon('retrying') : tCta('retry')}
                </button>
              </form>
            )}
            <Link href={`/tasks/${taskId}`} className="gp-btn" data-variant="ghost" data-size="sm">
              {tCta('view_detail')}
            </Link>
          </div>
          {retryState.error && <div className="gp-note-bubble__form-err">{retryState.error}</div>}
        </>
      )}

      {(status === 'pending' || status === 'processing') && (
        <p className="gp-note-bubble__hint">{tBubble('processing_hint')}</p>
      )}

      {pollError && <div className="gp-note-bubble__poll-err">{pollError}</div>}
    </div>
  );
}
