import { type DrizzleDB, getRawDatabase } from '../db/connection';
import type { SourceRepository, TaskLogRepository, TaskRepository } from '../db/repositories/types';

export interface RetryDeps {
  db: DrizzleDB;
  taskRepo: TaskRepository;
  sourceRepo: SourceRepository;
  taskLogRepo?: TaskLogRepository;
}

/**
 * Retry a failed task by resetting it to pending.
 *
 * §8.3 Preconditions:
 * - Only status=error tasks can be retried
 * - URL conflict check: reject if same normalized_url has an active source (processing/confirmed)
 *
 * §8.3 Reset rules (delegated to taskRepo.resetForRetry):
 * - Task: status→pending, pipeline_step→null, error_message→null, result→null, updated_at→now()
 * - inputType='url' preserved (set by Server Action), 'text'/'opinion' cleared (LLM-determined)
 * - Source: status→processing
 * - Both in same transaction
 *
 * V1: No checkpoint recovery — retry re-runs the full pipeline from scratch.
 */
export async function retryTask(taskId: number, deps: RetryDeps): Promise<void> {
  const { db, taskRepo, sourceRepo, taskLogRepo } = deps;

  // Pre-transaction validation (fail-fast to avoid acquiring write lock for invalid requests)
  // Authoritative re-check happens inside resetForRetry() under BEGIN IMMEDIATE
  const task = taskRepo.getById(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  // 2. Only error tasks can be retried
  if (task.status !== 'error') {
    throw new Error(`Only error tasks can be retried, current status: ${task.status}`);
  }

  // 3. Fetch associated source
  const source = sourceRepo.getById(task.sourceId);
  if (!source) {
    throw new Error(`Source not found: ${task.sourceId}`);
  }

  // 4. Atomic reset within BEGIN IMMEDIATE
  const rawDb = getRawDatabase(db);
  const doRetry = rawDb.transaction(() => {
    // Re-read source under write lock to prevent TOCTOU with concurrent discard/delete
    const freshSource = sourceRepo.getById(task.sourceId);
    if (!freshSource) {
      throw new Error(`Source not found (deleted concurrently?): ${task.sourceId}`);
    }

    // 5. URL conflict check (only for sources with a URL)
    if (freshSource.normalizedUrl) {
      const activeSource = sourceRepo.findActiveByNormalizedUrl(freshSource.normalizedUrl);
      if (activeSource && activeSource.id !== freshSource.id) {
        throw new Error(
          `Cannot retry: an active source already exists for URL ${freshSource.normalizedUrl}`,
        );
      }
    }

    // 6. Clear stale logs from the failed run so the debug timeline starts fresh
    taskLogRepo?.deleteByTaskId(taskId);

    // 7. Reset task (preserves inputType=url, clears text/opinion)
    taskRepo.resetForRetry(taskId);

    // 8. Reset source status to processing
    sourceRepo.updateStatus(freshSource.id, 'processing');
  });

  doRetry.immediate();
}
