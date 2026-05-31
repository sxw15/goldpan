'use client';

import type { Task, TaskStatus, TaskStatusCounts } from '@goldpan/web-sdk';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConfirm } from '@/components/confirm-provider';
import { StateEmpty } from '@/components/state/state-empty';
import { StateError } from '@/components/state/state-error';
import { useTz } from '@/components/tz-provider';
import { useVisibilityAwarePolling } from '@/hooks/use-visibility-aware-polling';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import { formatRelativeTime } from '@/lib/format';
import { deriveTaskTitle, TASK_STATUS_CHIP } from '@/lib/task-display';

type StatusFilter = 'all' | TaskStatus;

const VALID_FILTERS: readonly StatusFilter[] = [
  'all',
  'pending',
  'processing',
  'done',
  'error',
] as const;
const POLL_INTERVAL_MS = 30_000;

interface TasksPageClientProps {
  initialTasks: Task[];
  initialCounts: TaskStatusCounts;
  initialError: string | null;
  limit: number;
}

function isStatusFilter(value: string): value is StatusFilter {
  return (VALID_FILTERS as readonly string[]).includes(value);
}

function parseFilter(raw: string | null): StatusFilter {
  return raw && isStatusFilter(raw) ? raw : 'all';
}

function tasksUnchanged(prev: Task[], next: Task[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (
      a.id !== b.id ||
      a.status !== b.status ||
      a.retryCount !== b.retryCount ||
      a.llmCount !== b.llmCount ||
      a.durationS !== b.durationS
    ) {
      return false;
    }
  }
  return true;
}

function countsUnchanged(prev: TaskStatusCounts, next: TaskStatusCounts): boolean {
  return (
    prev.pending === next.pending &&
    prev.processing === next.processing &&
    prev.done === next.done &&
    prev.error === next.error
  );
}

export function TasksPageClient({
  initialTasks,
  initialCounts,
  initialError,
  limit,
}: TasksPageClientProps) {
  const t = useTranslations('tasks');
  const tCommon = useTranslations('common');
  const tTime = useTranslations('time');
  const tz = useTz();
  const router = useRouter();
  const searchParams = useSearchParams();
  const confirm = useConfirm();
  const filter = parseFilter(searchParams?.get('status') ?? null);

  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [counts, setCounts] = useState<TaskStatusCounts>(initialCounts);
  const [blockingListError, setBlockingListError] = useState<boolean>(initialError !== null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [actionErrorKey, setActionErrorKey] = useState<
    'list_action_retry_failed' | 'list_action_delete_failed' | null
  >(null);
  const [pendingActionId, setPendingActionId] = useState<number | null>(null);
  const fetchControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  /** SSR succeeded or we have successfully loaded once — polling/refresh errors stay inline. */
  const listEverOkRef = useRef(initialError === null);

  const fetchTasks = useCallback(async () => {
    fetchControllerRef.current?.abort();
    const controller = new AbortController();
    fetchControllerRef.current = controller;
    try {
      const result = await getBrowserApiClient().getTasks(
        { limit, status: filter === 'all' ? undefined : [filter] },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      listEverOkRef.current = true;
      setTasks((prev) => (tasksUnchanged(prev, result.data) ? prev : result.data));
      setCounts((prev) => (countsUnchanged(prev, result.counts) ? prev : result.counts));
      setBlockingListError(false);
      setRefreshFailed(false);
    } catch {
      if (controller.signal.aborted) return;
      if (listEverOkRef.current) {
        setRefreshFailed(true);
      } else {
        setBlockingListError(true);
      }
    }
  }, [filter, limit]);

  // SSR has already filled initial data for the current filter; skip fetch on mount.
  // Subsequent filter changes (fetchTasks identity flips) trigger a fresh server fetch.
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    fetchTasks();
  }, [fetchTasks]);

  useEffect(
    () => () => {
      fetchControllerRef.current?.abort();
    },
    [],
  );

  useVisibilityAwarePolling(fetchTasks, POLL_INTERVAL_MS);

  const handleFilterChange = useCallback(
    (next: StatusFilter) => {
      const params = new URLSearchParams(searchParams?.toString() ?? '');
      if (next === 'all') params.delete('status');
      else params.set('status', next);
      const qs = params.toString();
      router.replace(`/tasks${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [router, searchParams],
  );

  const handleRetry = useCallback(
    async (taskId: number) => {
      // Optimistic: flip the row to pending immediately so the button releases
      // and the user sees motion. fetchTasks() reconciles to server truth.
      setTasks((prev) =>
        prev.map((task) =>
          task.id === taskId
            ? {
                ...task,
                status: 'pending',
                retryCount: task.retryCount + 1,
                errorKind: null,
                durationS: null,
              }
            : task,
        ),
      );
      setActionErrorKey(null);
      setPendingActionId(taskId);
      try {
        await getBrowserApiClient().retryTask(taskId);
        void fetchTasks();
      } catch {
        // Inline alert + reconcile via fetchTasks; do NOT raise page-level
        // blockingListError — that would replace the whole list with StateError and
        // hide the user's other rows.
        setActionErrorKey('list_action_retry_failed');
        void fetchTasks();
      } finally {
        setPendingActionId(null);
      }
    },
    [fetchTasks],
  );

  const handleDelete = useCallback(
    async (taskId: number) => {
      const ok = await confirm({
        message: t('list_delete_confirm'),
        confirmLabel: tCommon('delete'),
        danger: true,
      });
      if (!ok) return;
      setActionErrorKey(null);
      setPendingActionId(taskId);
      try {
        await getBrowserApiClient().deleteTask(taskId);
        setTasks((prev) => prev.filter((task) => task.id !== taskId));
        void fetchTasks();
      } catch {
        setActionErrorKey('list_action_delete_failed');
        void fetchTasks();
      } finally {
        setPendingActionId(null);
      }
    },
    [confirm, fetchTasks, t, tCommon],
  );

  const tabCounts = useMemo<Record<StatusFilter, number>>(
    () => ({
      all: counts.pending + counts.processing + counts.done + counts.error,
      pending: counts.pending,
      processing: counts.processing,
      done: counts.done,
      error: counts.error,
    }),
    [counts],
  );

  const filterTotal = tabCounts[filter];

  let content: React.ReactNode;
  if (blockingListError) {
    content = (
      <StateError
        error={t('list_error_title')}
        onRetry={fetchTasks}
        retryLabel={t('list_error_retry')}
      />
    );
  } else if (tasks.length === 0) {
    if (filter === 'all') {
      content = (
        <StateEmpty
          title={t('list_empty_title')}
          action={
            <Link href="/" className="gp-btn" data-variant="ghost">
              {t('list_empty_action')}
            </Link>
          }
        />
      );
    } else {
      content = <StateEmpty title={t('list_filtered_empty')} />;
    }
  } else {
    content = (
      <ul className="gp-tasks-list">
        {tasks.map((task) => (
          <li key={task.id} className="gp-tasks-row">
            <Link
              href={`/tasks/${task.id}`}
              className="gp-tasks-row__body"
              aria-label={t('list_open_aria', { id: task.id })}
            >
              <div className="gp-tasks-row__main">
                <span className={`gp-status ${TASK_STATUS_CHIP[task.status]}`}>
                  {t(`status_${task.status}`)}
                </span>
                <span className="gp-tasks-row__title">{deriveTaskTitle(task, t)}</span>
              </div>
              <div className="gp-tasks-row__meta">
                <span>{formatRelativeTime(task.createdAt, tTime, tz)}</span>
                {task.durationS != null ? (
                  <span>{t('list_stat_duration', { seconds: Math.round(task.durationS) })}</span>
                ) : null}
                {task.llmCount > 0 ? (
                  <span>{t('list_stat_llm_count', { count: task.llmCount })}</span>
                ) : null}
                {task.retryCount > 0 ? (
                  <span>{t('list_stat_retry_count', { count: task.retryCount })}</span>
                ) : null}
              </div>
            </Link>
            <div className="gp-tasks-row__actions">
              {task.status === 'error' ? (
                <button
                  type="button"
                  className="gp-btn"
                  data-variant="ghost"
                  disabled={pendingActionId === task.id}
                  onClick={() => handleRetry(task.id)}
                  aria-label={t('list_retry_aria', { id: task.id })}
                >
                  {t('list_action_retry')}
                </button>
              ) : null}
              {task.status === 'done' || task.status === 'error' ? (
                <button
                  type="button"
                  className="gp-btn"
                  data-variant="danger"
                  disabled={pendingActionId === task.id}
                  onClick={() => handleDelete(task.id)}
                  aria-label={t('list_delete_aria', { id: task.id })}
                >
                  {t('list_action_delete')}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="gp-tasks-list-page">
      <header className="gp-tasks-list-page__header">
        <h1 className="gp-tasks-list-page__title">{t('list_page_heading')}</h1>
        <p className="gp-tasks-list-page__subtitle">{t('list_page_subtitle')}</p>
        <div className="gp-tasks-filters" role="tablist" aria-label={t('list_page_heading')}>
          {VALID_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className="gp-tasks-filters__tab"
              data-active={filter === f ? '' : undefined}
              onClick={() => handleFilterChange(f)}
            >
              <span>{t(`list_filter_${f}`)}</span>
              <span className="gp-tasks-filters__count">{tabCounts[f]}</span>
            </button>
          ))}
        </div>
      </header>

      {actionErrorKey ? (
        <div className="gp-tasks-list-page__action-error" role="alert">
          <span>{t(actionErrorKey)}</span>
          <button
            type="button"
            className="gp-tasks-list-page__action-error-dismiss"
            onClick={() => setActionErrorKey(null)}
          >
            {t('list_action_error_dismiss')}
          </button>
        </div>
      ) : null}

      {refreshFailed ? (
        <div className="gp-tasks-list-page__action-error" role="alert">
          <span>{t('list_refresh_failed')}</span>
          <button
            type="button"
            className="gp-tasks-list-page__action-error-dismiss"
            onClick={() => {
              setRefreshFailed(false);
              void fetchTasks();
            }}
          >
            {t('list_error_retry')}
          </button>
          <button
            type="button"
            className="gp-tasks-list-page__action-error-dismiss"
            onClick={() => setRefreshFailed(false)}
          >
            {t('list_action_error_dismiss')}
          </button>
        </div>
      ) : null}

      {content}

      {filterTotal > tasks.length ? (
        <p className="gp-tasks-list-page__truncated-hint">{t('list_truncated_hint')}</p>
      ) : null}
    </div>
  );
}
