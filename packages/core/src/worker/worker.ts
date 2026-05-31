import type { ILogObj, Logger } from 'tslog';
import type { GoldpanConfig } from '../config/index';
import { type DrizzleDB, getRawDatabase } from '../db/connection';
import {
  type InputType,
  type SourceRepository,
  type TaskRepository,
  VALID_INPUT_TYPES,
} from '../db/repositories/types';
import { errorMessage, PipelineError } from '../errors';
import { t } from '../i18n/index';
import type { Pipeline, PipelineContext } from '../pipeline/index';
import { mapToPipelineStep } from '../pipeline/orchestrator';

export interface WorkerDeps {
  taskRepo: TaskRepository;
  sourceRepo: SourceRepository;
  workerInterval: number;
  logger: Logger<ILogObj>;
  pipeline: Pipeline;
  config: GoldpanConfig;
  db?: DrizzleDB;
}

declare global {
  var __goldpan_worker_started: boolean | undefined;
  var __goldpan_worker_timer: ReturnType<typeof setTimeout> | undefined;
  var __goldpan_worker_inflight: Promise<void> | null | undefined;
}

/**
 * Start the background worker polling loop.  §8.1
 *
 * Idempotent — guarded by `globalThis.__goldpan_worker_started`.
 * On first call performs crash recovery via `taskRepo.resetAllProcessing()`
 * (resets stuck "processing" tasks to "pending", preserving inputType=url).
 * Then starts a recursive `setTimeout` that calls `pollAndProcess` each cycle.
 * Using setTimeout (instead of setInterval) ensures the next poll only
 * schedules after the current one completes, preventing call stacking when
 * pipeline execution takes longer than the polling interval.
 */
export function startWorker(deps: WorkerDeps): void {
  const { taskRepo, logger, workerInterval } = deps;

  if (globalThis.__goldpan_worker_started) {
    logger.warn('Worker already running — skipping duplicate startWorker()');
    return;
  }

  // Crash recovery: reset any tasks stuck in "processing" from a previous crash.
  // §8.1: "corresponding source status remains unchanged (naturally updated on pipeline re-run)" — do NOT reset source status here.
  // The pipeline re-run will naturally update source status as it processes.
  const resetCount = taskRepo.resetAllProcessing();
  if (resetCount > 0) {
    logger.info(`Crash recovery: reset ${resetCount} processing task(s) to pending`);
  }

  globalThis.__goldpan_worker_started = true;

  const runPoll = async () => {
    try {
      await pollAndProcess(deps);
    } catch (err) {
      try {
        deps.logger.error('Worker poll error:', err);
      } catch {
        /* logger failure must never break the poll loop */
      }
    } finally {
      scheduleNext();
    }
  };

  const scheduleNext = () => {
    if (!globalThis.__goldpan_worker_started) return;
    globalThis.__goldpan_worker_timer = setTimeout(runPoll, workerInterval * 1000);
  };

  // Fire immediately — don't wait for first interval tick
  globalThis.__goldpan_worker_timer = setTimeout(runPoll, 0);

  logger.info(`Worker started (interval: ${workerInterval}s)`);
}

/**
 * Stop the worker polling loop, clear the timer, reset globalThis flags, and
 * await any in-flight pipeline work (same ordering as `drainAndStop`).
 * Safe to call when the worker is not running.
 */
export async function stopWorker(): Promise<void> {
  // Clear the started flag FIRST so that scheduleNext() (which checks this
  // flag) won't schedule a new timer when the in-flight promise resolves.
  delete globalThis.__goldpan_worker_started;
  if (globalThis.__goldpan_worker_timer) {
    clearTimeout(globalThis.__goldpan_worker_timer);
  }
  delete globalThis.__goldpan_worker_timer;
  if (globalThis.__goldpan_worker_inflight) {
    try {
      await globalThis.__goldpan_worker_inflight;
    } catch {
      /* already handled by pollAndProcess */
    }
  }
}

/**
 * Drain in-flight work and stop the worker gracefully.
 * Waits for any currently processing pipeline to finish before stopping.
 */
export async function drainAndStop(): Promise<void> {
  return stopWorker();
}

/**
 * Single poll cycle: claim one pending task, build PipelineContext, run pipeline.
 *
 * State persistence is delegated to the pipeline orchestrator (Phase 4):
 * - On success or PipelineError the orchestrator has already called
 *   markDone / markError / updateStatus — the worker only logs.
 * - On unexpected (non-PipelineError) errors the worker acts as a safety net,
 *   persisting error state only if the task is still "processing".  §8.1
 */
async function pollAndProcess(deps: WorkerDeps): Promise<void> {
  const { taskRepo, sourceRepo, pipeline, config, logger } = deps;

  // Single-concurrency guard: skip if a task is already in-flight
  if (taskRepo.hasProcessingTask()) {
    logger.debug('Poll skipped — a task is already processing');
    return;
  }

  const task = taskRepo.claimNextPending();
  if (!task) return;

  const source = sourceRepo.getById(task.sourceId);
  if (!source) {
    logger.error(`Source ${task.sourceId} not found for task ${task.id}`);
    taskRepo.markError(
      task.id,
      null,
      t('worker.source_not_found', { sourceId: String(task.sourceId) }),
      'unknown',
    );
    return;
  }

  const ctx: PipelineContext = {
    task,
    source,
    config,
    inputType: VALID_INPUT_TYPES.has(task.inputType ?? '') ? (task.inputType as InputType) : null,
    content: null,
    classification: null,
    points: [],
    matchingOutput: null,
    entityJudgments: [],
    verifierRejections: [],
    validationResult: null,
    validationWarnings: [],
  };

  const pipelinePromise = pipeline.process(ctx);
  globalThis.__goldpan_worker_inflight = pipelinePromise
    .then(() => {})
    .catch(() => {})
    .finally(() => {
      globalThis.__goldpan_worker_inflight = null;
    });
  try {
    await pipelinePromise;
    logger.info(`Task ${task.id} completed`);
  } catch (err) {
    if (err instanceof PipelineError) {
      logger.error(`Task ${task.id} failed at step [${err.step}]: ${err.message}`);
    } else {
      logger.error(`Task ${task.id} unexpected error:`, err);
    }

    // Safety net: persist error state if orchestrator hasn't already.
    // For PipelineError the orchestrator normally handles this, but its own
    // markError/updateStatus can fail (e.g. disk full). For non-PipelineError
    // the orchestrator may not have persisted state at all.
    try {
      const refreshedTask = taskRepo.getById(task.id);
      if (refreshedTask && refreshedTask.status === 'processing') {
        const msg = errorMessage(err);
        const rawStep = err instanceof PipelineError ? err.step : null;
        const step = mapToPipelineStep(rawStep);
        const kind = err instanceof PipelineError ? err.kind : 'unknown';
        const doUpdate = (emitTerminated = true) => {
          taskRepo.markError(task.id, step, msg, kind);
          sourceRepo.updateStatus(
            source.id,
            'failed',
            emitTerminated ? undefined : { emitTerminated: false },
          );
        };
        if (deps.db) {
          const raw = getRawDatabase(deps.db);
          raw.transaction(() => doUpdate(false)).immediate();
          sourceRepo.emitTerminated(source.id, 'failed');
        } else {
          // No DB handle available (e.g. test environments) — write non-transactionally
          doUpdate();
        }
      }
    } catch (safetyErr) {
      // Safety-net: if even the error-marking DB write fails (e.g. disk full,
      // DB locked), log and move on. The task will remain in 'processing'
      // and can be retried manually via the UI.
      logger.error(`Safety-net persistence also failed for task ${task.id}:`, safetyErr);
    }
  }
}
