import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../db/connection';
import { getRawDatabase } from '../db/connection';
import type {
  ProcessingTask,
  Source,
  SourceKind,
  SourceRepository,
  TaskLogRepository,
  TaskRepository,
  TaskStatus,
} from '../db/repositories/types';
import { eventLogs, llmCalls, processingTasks, sources, taskLogs } from '../db/schema';

// ─── TaskSummary ────────────────────────────────────────────

export interface TaskSummary {
  id: number;
  sourceId: number;
  status: TaskStatus;
  createdAt: number;
  pipelineStep: string | null;
  inputType: string | null;
  result: Record<string, unknown> | null;
  errorKind: string | null;
  /** Wall-clock seconds between earliest and latest task_log timestamp; null when no logs. */
  durationS: number | null;
  /** llm_calls observed against this source — see retry note in getRecentTasksWithSources. */
  llmCount: number;
  /** Subset of llmCount where attempt_number > 1 (retries within a single step). */
  retryCount: number;
  source: {
    originalUrl: string | null;
    normalizedUrl: string | null;
    title?: string | null;
    rawContentPreview?: string | null;
    status: string;
    kind: SourceKind;
    origin: string;
  } | null;
}

const VALID_TASK_STATUSES = new Set<TaskStatus>(['pending', 'processing', 'done', 'error']);

export function getRecentTasksWithSources(
  taskRepo: TaskRepository,
  sourceRepo: SourceRepository,
  db: DrizzleDB,
  limit = 20,
  statusFilter?: readonly TaskStatus[],
): TaskSummary[] {
  const recentTasks = taskRepo.getRecent(limit, statusFilter);
  if (recentTasks.length === 0) return [];

  const taskIds = recentTasks.map((t) => t.id);
  const sourceIds = [...new Set(recentTasks.map((task) => task.sourceId))];
  const sourcesArr = sourceRepo.getByIds(sourceIds);
  const sourceMap = new Map(sourcesArr.map((s) => [s.id, s]));

  // Duration per task: max(timestamp) − min(timestamp) within task_logs, in seconds.
  // timestamps are INTEGER epoch milliseconds; divide by 1000 for seconds.
  const durationRows = db
    .select({
      taskId: taskLogs.taskId,
      durationS: sql<
        number | null
      >`(MAX(${taskLogs.timestamp}) - MIN(${taskLogs.timestamp})) / 1000.0`,
    })
    .from(taskLogs)
    .where(inArray(taskLogs.taskId, taskIds))
    .groupBy(taskLogs.taskId)
    .all();
  const durationMap = new Map<number, number | null>();
  for (const r of durationRows) {
    const dur = r.durationS;
    durationMap.set(
      r.taskId,
      typeof dur === 'number' && Number.isFinite(dur) ? Math.max(0, dur) : null,
    );
  }

  // LLM totals per source. retry resets task_logs but preserves llm_calls, so a retried
  // source's count accumulates across runs. Both list and detail page show the same
  // source-scoped count for consistency. Per-run attribution would require a task_id
  // column on llm_calls.
  const llmTotalsBySource = new Map<number, { total: number; retries: number }>();
  if (sourceIds.length > 0) {
    const rows = db
      .select({
        sourceId: llmCalls.sourceId,
        total: sql<number>`COUNT(*)`,
        retries: sql<number>`SUM(CASE WHEN ${llmCalls.attemptNumber} > 1 THEN 1 ELSE 0 END)`,
      })
      .from(llmCalls)
      .where(inArray(llmCalls.sourceId, sourceIds))
      .groupBy(llmCalls.sourceId)
      .all();
    for (const r of rows) {
      if (r.sourceId == null) continue;
      llmTotalsBySource.set(r.sourceId, {
        total: Number(r.total) || 0,
        retries: Number(r.retries) || 0,
      });
    }
  }

  return recentTasks.map((task) => {
    const source = sourceMap.get(task.sourceId);
    const status: TaskStatus = VALID_TASK_STATUSES.has(task.status as TaskStatus)
      ? (task.status as TaskStatus)
      : 'error';

    let parsedResult = null;
    if (task.status === 'done' && task.result) {
      try {
        parsedResult = JSON.parse(task.result);
      } catch {
        /* ignore corrupt JSON */
      }
    }

    const llm = llmTotalsBySource.get(task.sourceId);

    return {
      id: task.id,
      sourceId: task.sourceId,
      status,
      createdAt: task.createdAt,
      pipelineStep: task.pipelineStep ?? null,
      inputType: task.inputType ?? null,
      result: parsedResult,
      errorKind: task.errorKind ?? null,
      durationS: durationMap.get(task.id) ?? null,
      llmCount: llm?.total ?? 0,
      retryCount: llm?.retries ?? 0,
      source: source
        ? {
            originalUrl: source.originalUrl,
            normalizedUrl: source.normalizedUrl,
            title: source.title ?? null,
            rawContentPreview: source.rawContent ? source.rawContent.slice(0, 80) : null,
            status: source.status,
            kind: source.kind === 'external' ? 'external' : 'user',
            origin: source.origin,
          }
        : {
            originalUrl: null,
            normalizedUrl: null,
            title: null,
            rawContentPreview: null,
            status: 'failed',
            kind: 'user',
            origin: 'user',
          },
    };
  });
}

// ─── deleteTask ─────────────────────────────────────────────

export type DeleteTaskResult =
  | { ok: true }
  | { ok: false; code: 'not_found' | 'is_processing' | 'is_done' };

export function deleteTask(taskId: number, db: DrizzleDB): DeleteTaskResult {
  const rawDb = getRawDatabase(db);
  try {
    return rawDb
      .transaction(() => {
        const task = db.select().from(processingTasks).where(eq(processingTasks.id, taskId)).get();
        if (!task) return { ok: false as const, code: 'not_found' as const };
        if (task.status === 'processing')
          return { ok: false as const, code: 'is_processing' as const };
        if (task.status === 'done') return { ok: false as const, code: 'is_done' as const };

        const source = db.select().from(sources).where(eq(sources.id, task.sourceId)).get();

        db.delete(processingTasks).where(eq(processingTasks.id, taskId)).run();

        if (source && source.status !== 'confirmed' && source.status !== 'confirmed_empty') {
          const otherTask = db
            .select({ id: processingTasks.id })
            .from(processingTasks)
            .where(and(eq(processingTasks.sourceId, source.id), ne(processingTasks.id, taskId)))
            .get();

          if (!otherTask) {
            db.delete(eventLogs).where(eq(eventLogs.sourceId, source.id)).run();
            db.delete(sources).where(eq(sources.id, source.id)).run();
          }
        }

        return { ok: true as const };
      })
      .immediate();
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      return { ok: false, code: 'not_found' };
    }
    throw err;
  }
}

// ─── clearTaskLogs ──────────────────────────────────────────

export type ClearTaskLogsResult = { ok: true } | { ok: false; code: 'not_found' };

export function clearTaskLogs(
  taskId: number,
  taskRepo: TaskRepository,
  taskLogRepo: TaskLogRepository,
): ClearTaskLogsResult {
  const task = taskRepo.getById(taskId);
  if (!task) return { ok: false, code: 'not_found' };
  taskLogRepo.deleteByTaskId(taskId);
  return { ok: true };
}

// ─── validateRetryPreconditions ─────────────────────────────

/**
 * A task error is retryable unless re-running would deterministically reproduce
 * the same failure. Non-retryable:
 * - `content_policy`: the policy verdict won't change on a re-run of the same content.
 * - any OTHER `content_validation`-step failure (e.g. the wrapped `unknown`):
 *   the validated output won't change without new input.
 *
 * `content_length` is the deliberate exception — it surfaces at the
 * `content_validation` step, but the min/max limits are user-configurable
 * (Settings → 采集 · 内容长度) and the pipeline re-reads them per run via
 * `ctx.config`, so raising/lowering a limit and retrying genuinely succeeds.
 *
 * Single source of truth — consumed by the `/tasks/:id` status response
 * (`retryable` field) AND the retry precondition gate below, so the UI's retry
 * affordance and the server's enforcement can never disagree.
 */
export function isRetryableTaskError(
  pipelineStep: string | null,
  errorKind: string | null,
): boolean {
  if (errorKind === 'content_policy') return false;
  // A 404 (collector NOT_FOUND) is terminal — the repo/page is gone or private,
  // so re-running the identical fetch can't change the outcome.
  if (errorKind === 'not_found') return false;
  if (pipelineStep === 'content_validation' && errorKind !== 'content_length') return false;
  return true;
}

export type RetryValidationResult =
  | { ok: true; task: ProcessingTask; source: Source }
  | {
      ok: false;
      code: 'not_found' | 'not_failed' | 'not_retryable' | 'source_not_found' | 'source_conflict';
    };

export function validateRetryPreconditions(
  taskId: number,
  taskRepo: TaskRepository,
  sourceRepo: SourceRepository,
): RetryValidationResult {
  const task = taskRepo.getById(taskId);
  if (!task) return { ok: false, code: 'not_found' };
  if (task.status !== 'error') return { ok: false, code: 'not_failed' };
  // Defense-in-depth: the UI hides the retry button for non-retryable kinds,
  // but a direct API call / future surface must not silently re-run them.
  if (!isRetryableTaskError(task.pipelineStep, task.errorKind)) {
    return { ok: false, code: 'not_retryable' };
  }

  const source = sourceRepo.getById(task.sourceId);
  if (!source) return { ok: false, code: 'source_not_found' };

  if (source.kind === 'external' && source.normalizedUrl) {
    const conflict = sourceRepo.findActiveByNormalizedUrl(source.normalizedUrl);
    if (conflict && conflict.id !== source.id) {
      return { ok: false, code: 'source_conflict' };
    }
  }

  return { ok: true, task, source };
}
