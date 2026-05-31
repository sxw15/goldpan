// apps/server/src/routes/tasks.ts

import type { TaskErrorKind, TaskStatus } from '@goldpan/core/db/repositories';
import {
  clearTaskLogs,
  deleteTask,
  getRecentTasksWithSources,
  isRetryableTaskError,
  type RetryValidationResult,
  validateRetryPreconditions,
} from '@goldpan/core/operations';
import { retryTask } from '@goldpan/core/worker';
import { parseId, type RouteContext, respond, respondError } from './types.js';

/** Failure codes from `validateRetryPreconditions` — keying the retry route's
 * statusMap by this (not `string`) makes "added a code, forgot the HTTP status"
 * a compile error. */
type RetryFailCode = Extract<RetryValidationResult, { ok: false }>['code'];

const VALID_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'pending',
  'processing',
  'done',
  'error',
]);

// User-visible message per error kind. Typed against TaskErrorKind so a new
// kind in core forces a compile error here — no silent fallback to
// "Processing failed" for kinds we should be naming explicitly.
const ERROR_KIND_MESSAGE: Record<TaskErrorKind, string> = {
  content_policy: 'Content policy violation',
  content_length: 'Content length is outside the allowed range',
  rate_limit: 'Rate limited',
  timeout: 'Processing timed out',
  schema_validation: 'Validation error',
  not_found: 'Source not found',
  unknown: 'Processing failed',
};

function parseStatusFilter(raw: string | null): readonly TaskStatus[] | undefined {
  if (!raw) return undefined;
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is TaskStatus => VALID_TASK_STATUSES.has(s as TaskStatus));
  return parsed.length > 0 ? parsed : undefined;
}

/**
 * Handle /tasks/* routes.
 * segments: [] = list, [id] = detail, [id, 'retry'] = retry, etc.
 */
export async function handleTaskRoutes(ctx: RouteContext): Promise<void> {
  const { req, res, segments, handle } = ctx;
  const { repos, db } = handle;

  // GET /tasks — list recent tasks (supports ?limit=, ?status=pending,error)
  if (req.method === 'GET' && segments.length === 0) {
    req.resume();
    try {
      const limitParam = ctx.url.searchParams.get('limit');
      const limit = limitParam ? Math.min(Math.max(1, Number(limitParam) || 50), 100) : 50;
      const statusFilter = parseStatusFilter(ctx.url.searchParams.get('status'));
      const tasks = getRecentTasksWithSources(repos.task, repos.source, db, limit, statusFilter);
      const counts = repos.task.getCountsByStatus();
      respond(res, 200, { data: tasks, total: tasks.length, counts });
    } catch (err) {
      handle.logger.error('GET /tasks failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Internal error');
    }
    return;
  }

  const taskId = parseId(segments[0]);
  if (taskId === null) {
    req.resume();
    respondError(res, 400, 'invalid_id', 'Invalid task ID');
    return;
  }

  // GET /tasks/:id — task detail
  if (req.method === 'GET' && segments.length === 1) {
    req.resume();
    try {
      const task = repos.task.getById(taskId);
      if (!task) {
        respondError(res, 404, 'not_found', 'Task not found');
        return;
      }

      const source = repos.source.getById(task.sourceId);
      const sourceStatus = source?.status ?? null;
      const logs = repos.taskLog.getByTaskId(taskId);

      switch (task.status) {
        case 'pending':
          respond(res, 200, {
            status: 'pending',
            taskId: String(task.id),
            sourceId: task.sourceId,
            createdAt: task.createdAt,
            sourceStatus,
            sourceUrl: source?.originalUrl ?? null,
            logs,
          });
          return;

        case 'processing':
          respond(res, 200, {
            status: 'processing',
            taskId: String(task.id),
            sourceId: task.sourceId,
            createdAt: task.createdAt,
            pipelineStep: task.pipelineStep,
            sourceStatus,
            sourceUrl: source?.originalUrl ?? null,
            logs,
          });
          return;

        case 'done': {
          let parsedResult: Record<string, unknown> = {};
          if (task.result) {
            try {
              parsedResult = JSON.parse(task.result);
            } catch {
              /* ignore corrupt JSON */
            }
          }
          respond(res, 200, {
            status: 'done',
            taskId: String(task.id),
            sourceId: task.sourceId,
            createdAt: task.createdAt,
            result: parsedResult,
            sourceStatus,
            sourceUrl: source?.originalUrl ?? null,
            logs,
          });
          return;
        }

        case 'error': {
          const retryable = isRetryableTaskError(task.pipelineStep, task.errorKind);
          const errorKind = (task.errorKind ?? 'unknown') as TaskErrorKind;
          const safeMessage = ERROR_KIND_MESSAGE[errorKind] ?? ERROR_KIND_MESSAGE.unknown;
          respond(res, 200, {
            status: 'error',
            taskId: String(task.id),
            sourceId: task.sourceId,
            createdAt: task.createdAt,
            error: {
              step: task.pipelineStep ?? 'unknown',
              kind: task.errorKind ?? 'unknown',
              message: safeMessage,
              retryable,
            },
            sourceStatus,
            sourceUrl: source?.originalUrl ?? null,
            logs,
          });
          return;
        }

        default:
          respondError(res, 500, 'internal', 'Unknown task status');
          return;
      }
    } catch (err) {
      handle.logger.error(`GET /tasks/${taskId} failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Internal error');
    }
    return;
  }

  // POST /tasks/:id/retry
  if (req.method === 'POST' && segments[1] === 'retry' && segments.length === 2) {
    req.resume();
    try {
      const check = validateRetryPreconditions(taskId, repos.task, repos.source);
      if (!check.ok) {
        const statusMap: Record<RetryFailCode, number> = {
          not_found: 404,
          not_failed: 400,
          not_retryable: 409,
          source_not_found: 400,
          source_conflict: 409,
        };
        respondError(res, statusMap[check.code] ?? 400, check.code, check.code.replace(/_/g, ' '));
        return;
      }

      await retryTask(taskId, {
        db,
        taskRepo: repos.task,
        sourceRepo: repos.source,
        taskLogRepo: repos.taskLog,
      });
      respond(res, 200, { ok: true });
    } catch (err) {
      handle.logger.error(`POST /tasks/${taskId}/retry failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Retry failed');
    }
    return;
  }

  // DELETE /tasks/:id
  if (req.method === 'DELETE' && segments.length === 1) {
    req.resume();
    try {
      const result = deleteTask(taskId, db);
      if (!result.ok) {
        const statusMap: Record<string, number> = {
          not_found: 404,
          is_processing: 400,
          is_done: 400,
        };
        respondError(
          res,
          statusMap[result.code] ?? 400,
          result.code,
          result.code.replace(/_/g, ' '),
        );
        return;
      }
      respond(res, 200, { ok: true });
    } catch (err) {
      handle.logger.error(`DELETE /tasks/${taskId} failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Delete failed');
    }
    return;
  }

  // DELETE /tasks/:id/logs
  if (req.method === 'DELETE' && segments[1] === 'logs' && segments.length === 2) {
    req.resume();
    try {
      const result = clearTaskLogs(taskId, repos.task, repos.taskLog);
      if (!result.ok) {
        respondError(res, 404, result.code, 'Task not found');
        return;
      }
      respond(res, 200, { ok: true });
    } catch (err) {
      handle.logger.error(`DELETE /tasks/${taskId}/logs failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Clear logs failed');
    }
    return;
  }

  req.resume();
  respondError(res, 404, 'not_found', 'Not found');
}
