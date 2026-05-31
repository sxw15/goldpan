'use client';

import { useTranslations } from 'next-intl';
import { startTransition, useActionState, useState } from 'react';
import { type DeleteTaskState, deleteTaskAction } from '@/actions/delete-task';
import { type DiscardState, discardAction } from '@/actions/discard';
import { type RetryState, retryAction } from '@/actions/retry';
import { DoneView } from '@/components/task-detail/done-view';
import { ErrorView } from '@/components/task-detail/error-view';
import { ProcessingView } from '@/components/task-detail/processing-view';
import { useMobile } from '@/components/task-detail/use-mobile';
import { ToastStack, useToastStack } from '@/components/toast-stack';
import { type TaskLogEntry, useTaskPolling } from '@/lib/polling';
import { localizeErrorKind } from '@/lib/task-error';
import type { ProcessingResult } from '@/types/processing-result';

interface TaskDetailClientProps {
  taskId: number;
  sourceId: number;
  sourceUrl: string | null;
  sourceStatus: string | null;
  createdAt: number | null;
  initialStatus: string;
  initialResult: unknown;
  initialErrorKind: string | null;
  initialRetryable: boolean | null;
  initialErrorStep: string | null;
  initialPipelineStep: string | null;
  initialLogs: TaskLogEntry[];
}

const VALID_STATUSES: ReadonlyArray<'pending' | 'processing' | 'done' | 'error'> = [
  'pending',
  'processing',
  'done',
  'error',
];

export function TaskDetailClient({
  taskId,
  sourceId,
  sourceUrl,
  sourceStatus,
  createdAt,
  initialStatus,
  initialResult,
  initialErrorKind,
  initialRetryable,
  initialErrorStep,
  initialPipelineStep,
  initialLogs,
}: TaskDetailClientProps) {
  const t = useTranslations('task_detail');
  const pollingT = useTranslations('polling');
  const mobile = useMobile();

  const [optimisticStatus, setOptimisticStatus] = useState<string | null>(null);
  const derivedStatus = optimisticStatus ?? initialStatus;
  const shouldPoll = derivedStatus === 'pending' || derivedStatus === 'processing';

  const { toasts, api: toastApi } = useToastStack();

  const {
    data,
    isPolling,
    error: pollError,
    notFound,
  } = useTaskPolling({
    taskId,
    enabled: shouldPoll,
    t: (key) => pollingT(key),
  });

  const [discardState, discardFormAction, isDiscarding] = useActionState<DiscardState, FormData>(
    discardAction,
    {},
  );

  const [, retryFormAction, isRetrying] = useActionState<RetryState, FormData>(
    async (prevState: RetryState, formData: FormData) => {
      setOptimisticStatus('pending');
      const result = await retryAction(prevState, formData);
      if (result.error) {
        setOptimisticStatus(null);
        toastApi.push({ msg: result.error, kind: 'danger' });
      }
      return result;
    },
    {},
  );

  const [, deleteFormAction, isDeleting] = useActionState<DeleteTaskState, FormData>(
    async (prevState: DeleteTaskState, formData: FormData) => {
      const result = await deleteTaskAction(prevState, formData);
      if (result.error) {
        toastApi.push({ msg: result.error, kind: 'danger' });
      }
      return result;
    },
    {},
  );

  const currentStatus = data?.status ?? derivedStatus;
  const currentSourceStatus = data?.sourceStatus ?? sourceStatus;
  const currentLogs: TaskLogEntry[] = data?.logs ?? initialLogs;
  const currentSourceUrl = data?.sourceUrl ?? sourceUrl ?? null;

  const livePipelineStep = data?.status === 'processing' ? (data.pipelineStep ?? null) : null;
  const pipelineStep = livePipelineStep ?? initialPipelineStep;

  const showDiscard =
    currentSourceStatus === 'confirmed' || currentSourceStatus === 'confirmed_empty';
  const showDelete = currentStatus !== 'done' && currentStatus !== 'processing';

  const sourceKindLabel =
    data?.status === 'done' && data.result?.source?.kind
      ? formatSourceKind(data.result.source.kind, t)
      : '';

  if (notFound) {
    // The task was deleted (or never existed). Neutral tombstone, not an
    // error — deletion is usually user-initiated and shouldn't read as a fault.
    return (
      <div className="gp-td-page">
        <div className="gp-td-main" style={{ color: 'var(--gp-ink-muted)' }}>
          {pollingT('task_deleted')}
        </div>
      </div>
    );
  }

  if (pollError) {
    return (
      <div className="gp-td-page">
        <div className="gp-td-main" style={{ color: 'var(--gp-danger)' }}>
          {t('polling_error', { error: pollError })}
        </div>
      </div>
    );
  }

  if (currentStatus === 'pending' || currentStatus === 'processing') {
    return (
      <>
        <ProcessingView
          taskId={taskId}
          status={currentStatus}
          sourceUrl={currentSourceUrl}
          sourceTitle={null}
          createdAt={createdAt}
          sourceKindLabel={sourceKindLabel}
          pipelineStep={pipelineStep}
          isPolling={isPolling}
          logs={currentLogs}
          isDeleting={isDeleting}
          showDelete={showDelete && currentStatus === 'pending'}
          mobile={mobile}
          onCancel={() => {
            const fd = new FormData();
            fd.append('taskId', String(taskId));
            startTransition(() => deleteFormAction(fd));
          }}
        />
        <ToastStack toasts={toasts} dismiss={toastApi.dismiss} closeLabel={t('close')} />
      </>
    );
  }

  if (currentStatus === 'error') {
    const liveErrorKind = data?.status === 'error' ? data.error.kind : null;
    const liveErrorStep = data?.status === 'error' ? data.error.step : null;
    const liveRetryable = data?.status === 'error' ? data.error.retryable : null;
    const errorKind = liveErrorKind ?? initialErrorKind;
    const errorStep = liveErrorStep ?? initialErrorStep ?? null;
    // Unknown retryability (neither poll nor SSR set it) defaults to retryable —
    // never hide a legit recovery path; only an explicit server `false` suppresses it.
    const retryable = liveRetryable ?? initialRetryable ?? true;
    const errorMessage = localizeErrorKind(errorKind, t);
    return (
      <>
        <ErrorView
          taskId={taskId}
          sourceUrl={currentSourceUrl}
          sourceTitle={null}
          createdAt={createdAt}
          sourceKindLabel={sourceKindLabel}
          failedStep={errorStep}
          errorMessage={errorMessage}
          errorKind={errorKind}
          retryable={retryable}
          technicalLog={null}
          isRetrying={isRetrying}
          isDeleting={isDeleting}
          showDelete={showDelete}
          mobile={mobile}
          onRetry={() => {
            const fd = new FormData();
            fd.append('taskId', String(taskId));
            startTransition(() => retryFormAction(fd));
          }}
          onDelete={() => {
            const fd = new FormData();
            fd.append('taskId', String(taskId));
            startTransition(() => deleteFormAction(fd));
          }}
          toast={toastApi.push}
        />
        <ToastStack toasts={toasts} dismiss={toastApi.dismiss} closeLabel={t('close')} />
      </>
    );
  }

  if (currentStatus === 'done') {
    const liveResult = data?.status === 'done' ? data.result : null;
    const result = (liveResult ??
      (initialResult as ProcessingResult | null)) as ProcessingResult | null;
    if (!result || typeof result !== 'object' || !('stats' in result) || !('entities' in result)) {
      return (
        <div className="gp-td-page">
          <div className="gp-td-main">{t('completed_no_result')}</div>
        </div>
      );
    }
    return (
      <>
        <DoneView
          taskId={taskId}
          sourceUrl={currentSourceUrl}
          createdAt={createdAt}
          runtime={null}
          sourceKindLabel={sourceKindLabel}
          result={result}
          showDiscard={showDiscard}
          isDiscarded={!!discardState.success}
          isDiscarding={isDiscarding}
          mobile={mobile}
          onDiscardConfirm={() => {
            const fd = new FormData();
            fd.append('sourceId', String(sourceId));
            startTransition(() => discardFormAction(fd));
            toastApi.push({ msg: t('toast_discard_submitted'), kind: 'danger' });
          }}
          toast={toastApi.push}
        />
        {discardState.error && (
          <div
            style={{
              color: 'var(--gp-danger)',
              padding: '0 28px 16px',
              maxWidth: 880,
              margin: '0 auto',
            }}
          >
            {discardState.error}
          </div>
        )}
        <ToastStack toasts={toasts} dismiss={toastApi.dismiss} closeLabel={t('close')} />
      </>
    );
  }

  if (!VALID_STATUSES.includes(currentStatus as 'pending' | 'processing' | 'done' | 'error')) {
    return (
      <div className="gp-td-page">
        <div className="gp-td-main">{t('unknown_status', { status: currentStatus })}</div>
      </div>
    );
  }
  return null;
}

function formatSourceKind(
  kind: string,
  t: ReturnType<typeof useTranslations<'task_detail'>>,
): string {
  if (kind === 'user') return t('source_kind_user');
  if (kind === 'external') return t('source_kind_external');
  return kind;
}
