'use client';

import { Check, ChevronRight, RefreshCw, Sparkles, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { type DiscardState, discardAction } from '@/actions/discard';
import { type RetryState, retryAction } from '@/actions/retry';
import { useTaskPolling } from '@/lib/polling';
import { localizeErrorKind } from '@/lib/task-error';
import type { ProcessingResult } from '@/types/processing-result';

type ChatPipelineStep =
  | 'collecting'
  | 'classifying'
  | 'extracting'
  | 'matching'
  | 'relating'
  | 'comparing'
  | 'verifying'
  | 'validatePipelineOutput'
  | 'translating'
  | 'storing';

const PIPELINE_STEPS: readonly ChatPipelineStep[] = [
  'collecting',
  'classifying',
  'extracting',
  'matching',
  'relating',
  'comparing',
  'verifying',
  'validatePipelineOutput',
  'translating',
  'storing',
] as const;

function asPipelineStep(value: string | null | undefined): ChatPipelineStep | null {
  if (!value) return null;
  return PIPELINE_STEPS.includes(value as ChatPipelineStep) ? (value as ChatPipelineStep) : null;
}

const ENTITY_CHIP_LIMIT = 12;

interface TaskBubbleCardProps {
  taskId: number;
  /** When set, render the bubble as initially expanded (e.g., a freshly created
   * task users want to watch). Reloaded conversations stay collapsed. */
  defaultOpen?: boolean;
}

export function TaskBubbleCard({ taskId, defaultOpen = false }: TaskBubbleCardProps) {
  const tBubble = useTranslations('chat.task_bubble');
  const tStatus = useTranslations('chat.task_bubble.status');
  const tStat = useTranslations('chat.task_bubble.stats');
  const tCta = useTranslations('chat.task_bubble.cta');
  const tStep = useTranslations('chat.task_bubble.pipeline_step');
  const tPolling = useTranslations('polling');
  const tCommon = useTranslations('common');
  // Error messages localize from `error.kind` (same source as task detail) so
  // the bubble never shows the server's raw English `error.message`.
  const tTaskErr = useTranslations('task_detail');

  // Bumping `restartKey` makes useTaskPolling drop stale data and restart its
  // loop. We bump after a successful retry so the bubble flips from the
  // terminal `error` view to the live pipeline strip without a page reload.
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

  const [open, setOpen] = useState(defaultOpen);

  const status = data?.status ?? 'pending';
  const sourceId = data?.sourceId ?? null;
  const pipelineStep = data && data.status === 'processing' ? (data.pipelineStep ?? null) : null;
  const stepKey = asPipelineStep(pipelineStep);
  const stepIdx = stepKey ? PIPELINE_STEPS.indexOf(stepKey) : -1;

  const result: ProcessingResult | null =
    data?.status === 'done' ? (data.result as unknown as ProcessingResult) : null;
  const stats = result?.stats ?? null;
  const entities = result?.entities ?? [];
  const sourceTitle = result?.source?.title ?? data?.sourceUrl ?? null;
  const errorMsg = data?.status === 'error' ? localizeErrorKind(data.error.kind, tTaskErr) : null;
  const errorRetryable = data?.status === 'error' ? data.error.retryable : true;
  const sourceStatus = data?.sourceStatus ?? null;

  const StatusIcon = status === 'done' ? Check : status === 'error' ? X : Sparkles;

  // Stable IDs let the JSX inline the form actions without imperatively
  // creating <form> nodes.
  const [discardState, discardFormAction, isDiscarding] = useActionState<DiscardState, FormData>(
    discardAction,
    {},
  );
  const [retryState, retryFormAction, isRetrying] = useActionState<RetryState, FormData>(
    async (prev, formData) => {
      const result = await retryAction(prev, formData);
      if (result.success) setRestartKey((k) => k + 1);
      return result;
    },
    {},
  );

  const showDiscard =
    status === 'done' && (sourceStatus === 'confirmed' || sourceStatus === 'confirmed_empty');

  const titleFallback =
    status === 'error'
      ? tBubble('title_error')
      : status === 'done'
        ? tBubble('title_done')
        : tBubble('title_processing');

  if (notFound) {
    // Task was deleted — calm muted tombstone, not the red error bubble.
    return (
      <div
        className="gp-task-bubble"
        style={{ padding: '12px 14px', color: 'var(--gp-ink-muted)', fontSize: 13 }}
      >
        {tPolling('task_deleted')}
      </div>
    );
  }

  return (
    <div className={`gp-task-bubble gp-task-bubble--${status}`}>
      <button
        type="button"
        className="gp-task-bubble__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="gp-task-bubble__icon" aria-hidden>
          <StatusIcon size={14} />
        </span>
        <span className="gp-task-bubble__main">
          <span className="gp-task-bubble__row">
            <span className="gp-task-bubble__type">{tStatus(status)}</span>
            <span className="gp-task-bubble__id">{tBubble('task_prefix', { id: taskId })}</span>
          </span>
          <span className="gp-task-bubble__title" title={sourceTitle ?? undefined}>
            {sourceTitle ?? titleFallback}
          </span>
        </span>
        <span className={`gp-task-bubble__chev ${open ? 'is-open' : ''}`} aria-hidden>
          <ChevronRight size={14} />
        </span>
      </button>

      {(status === 'pending' || status === 'processing') && (
        <>
          <div className="gp-pipeline-strip" role="presentation">
            {PIPELINE_STEPS.map((s, i) => {
              const cls = i < stepIdx ? 'is-done' : i === stepIdx ? 'is-active' : '';
              return (
                <span key={s} className="gp-pipeline-strip__cell">
                  <span className={`gp-pipeline-strip__step ${cls}`}>{tStep(s)}</span>
                  {i < PIPELINE_STEPS.length - 1 && (
                    <span className="gp-pipeline-strip__sep" aria-hidden>
                      →
                    </span>
                  )}
                </span>
              );
            })}
          </div>
          <div className="gp-task-bubble__progress" aria-hidden>
            <div className="gp-task-bubble__progress-fill" />
          </div>
        </>
      )}

      {open && (
        <div className="gp-task-bubble__body">
          {status === 'done' && stats && (
            <>
              <div className="gp-task-bubble__stats">
                <div className="gp-task-bubble__stat">
                  <div className="gp-task-bubble__stat-num">{entities.length}</div>
                  <div className="gp-task-bubble__stat-label">{tStat('entities')}</div>
                </div>
                <div className="gp-task-bubble__stat gp-task-bubble__stat--ok">
                  <div className="gp-task-bubble__stat-num">+{stats.accepted}</div>
                  <div className="gp-task-bubble__stat-label">{tStat('accepted')}</div>
                </div>
                <div className="gp-task-bubble__stat gp-task-bubble__stat--mute">
                  <div className="gp-task-bubble__stat-num">{stats.skipped}</div>
                  <div className="gp-task-bubble__stat-label">{tStat('skipped')}</div>
                </div>
              </div>
              {entities.length > 0 && (
                <>
                  <div className="gp-task-bubble__entities-label">
                    {tStat('extracted_entities')}
                  </div>
                  <div className="gp-task-bubble__entities">
                    {entities.slice(0, ENTITY_CHIP_LIMIT).map((e) => {
                      const typeLabel = e.categoryPath?.split('/').pop() ?? '';
                      const href = e.entityId
                        ? `/library?focus=${e.entityId}&kind=entity`
                        : '/library';
                      return (
                        <Link
                          key={e.entityKey}
                          href={href}
                          className="gp-chip"
                          data-variant="entity"
                          data-state={e.isNew ? 'new' : undefined}
                        >
                          {typeLabel && <span className="gp-chip__type">{typeLabel}</span>}
                          {e.entityName}
                        </Link>
                      );
                    })}
                    {entities.length > ENTITY_CHIP_LIMIT && (
                      <span className="gp-chip__more">
                        {tStat('more_entities', { count: entities.length - ENTITY_CHIP_LIMIT })}
                      </span>
                    )}
                  </div>
                </>
              )}
              <div className="gp-task-bubble__cta">
                <Link
                  href={`/tasks/${taskId}`}
                  className="gp-btn"
                  data-variant="primary"
                  data-size="sm"
                >
                  {tCta('view_detail')}
                  <ChevronRight size={12} aria-hidden />
                </Link>
                {showDiscard && sourceId !== null && (
                  <form action={discardFormAction}>
                    <input type="hidden" name="sourceId" value={sourceId} />
                    <button
                      type="submit"
                      disabled={isDiscarding}
                      className="gp-btn"
                      data-variant="ghost"
                      data-size="sm"
                    >
                      <Trash2 size={11} aria-hidden />
                      {isDiscarding ? tCommon('discarding') : tCta('discard')}
                    </button>
                  </form>
                )}
              </div>
              {discardState.error && (
                <div className="gp-task-bubble__form-err">{discardState.error}</div>
              )}
            </>
          )}
          {status === 'error' && (
            <>
              {errorMsg && <div className="gp-task-bubble__err-msg">{errorMsg}</div>}
              <div className="gp-task-bubble__cta">
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
                <Link
                  href={`/tasks/${taskId}`}
                  className="gp-btn"
                  data-variant="ghost"
                  data-size="sm"
                >
                  {tCta('view_detail')}
                  <ChevronRight size={12} aria-hidden />
                </Link>
              </div>
              {retryState.error && (
                <div className="gp-task-bubble__form-err">{retryState.error}</div>
              )}
            </>
          )}
          {(status === 'pending' || status === 'processing') && (
            <p className="gp-task-bubble__hint">{tBubble('processing_hint')}</p>
          )}
        </div>
      )}

      {pollError && <div className="gp-task-bubble__poll-err">{pollError}</div>}
    </div>
  );
}
