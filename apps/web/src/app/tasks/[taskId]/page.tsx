import { GoldpanApiError, type TaskDetail } from '@goldpan/web-sdk';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { createServerClient } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { isLogEvent } from '@/lib/task-display';
import { TaskDetailClient } from './task-detail-client';

interface TaskDetailPageProps {
  params: Promise<{ taskId: string }>;
}

export async function generateMetadata({ params }: TaskDetailPageProps): Promise<Metadata> {
  const { taskId } = await params;
  const t = await getTranslations('metadata');
  return { title: t('page_task_detail', { id: taskId }) };
}

export default async function TaskDetailPage({ params }: TaskDetailPageProps) {
  await requireAuth();

  const { taskId: taskIdStr } = await params;
  const taskId = Number(taskIdStr);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    notFound();
  }

  const client = await createServerClient();
  let taskDetail: TaskDetail;
  try {
    taskDetail = await client.getTask(taskId);
  } catch (err) {
    if (err instanceof GoldpanApiError && err.status === 404) notFound();
    throw err;
  }

  const status = taskDetail.status;
  const sourceStatus = taskDetail.sourceStatus;
  const logs = taskDetail.logs;

  const initialResult = status === 'done' && 'result' in taskDetail ? taskDetail.result : null;
  // Pass the raw `kind` + `retryable` down — the client component localizes the
  // message from `kind` (shared `localizeErrorKind`) so SSR first paint and the
  // post-poll re-render stay identical and locale-correct (never the server's
  // raw English `error.message`).
  const initialErrorKind =
    status === 'error' && 'error' in taskDetail ? taskDetail.error.kind : null;
  const initialRetryable =
    status === 'error' && 'error' in taskDetail ? taskDetail.error.retryable : null;
  const initialErrorStep =
    status === 'error' && 'error' in taskDetail ? taskDetail.error.step : null;
  const initialPipelineStep =
    status === 'processing' && 'pipelineStep' in taskDetail ? taskDetail.pipelineStep : null;

  return (
    <TaskDetailClient
      taskId={taskId}
      sourceId={taskDetail.sourceId}
      sourceUrl={taskDetail.sourceUrl}
      sourceStatus={sourceStatus ?? null}
      createdAt={taskDetail.createdAt}
      initialStatus={status}
      initialResult={initialResult}
      initialErrorKind={initialErrorKind}
      initialRetryable={initialRetryable}
      initialErrorStep={initialErrorStep}
      initialPipelineStep={initialPipelineStep}
      initialLogs={logs.flatMap((log) =>
        isLogEvent(log.event) ? [{ ...log, event: log.event }] : [],
      )}
    />
  );
}
