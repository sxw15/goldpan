import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoldpanConfig } from '../../src/config/index.js';
import { getRawDatabase } from '../../src/db/connection.js';
import { SqliteSourceRepository } from '../../src/db/repositories/source.repository.js';
import { SqliteTaskRepository } from '../../src/db/repositories/task.repository.js';
import type { InputType, SourceStatus, TaskStatus } from '../../src/db/repositories/types.js';
import { PipelineError } from '../../src/errors.js';
import type { Pipeline, PipelineContext } from '../../src/pipeline/orchestrator.js';
import { startWorker, stopWorker, type WorkerDeps } from '../../src/worker/index.js';
import { createTestDB, type TestDB } from '../helpers/test-db.js';

// ─── Mock logger (suppress output) ────────────────────────────
const mockLogger: any = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  silly: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  getSubLogger: vi.fn().mockReturnThis(),
};

// ─── Minimal config for tests ──────────────────────────────────
function makeTestConfig(): GoldpanConfig {
  return {
    llm: {
      classifier: 'openai:gpt-4o-mini',
      extractor: 'anthropic:claude-sonnet-4-20250514',
      matcher: 'anthropic:claude-sonnet-4-20250514',
      comparator: 'anthropic:claude-sonnet-4-20250514',
      verifier: 'openai:gpt-4o-mini',
      verifierEnabled: false,
      intent: 'openai:gpt-4o-mini',
      query: 'anthropic:claude-sonnet-4-20250514',
    },
    workerInterval: 5,
    collectTimeout: 30,
    browserStrategy: 'auto',
    llmTimeout: 30,
    outputFullThreshold: 2,
    outputIncrementThreshold: 10,
    maxTextInputLength: 20000,
    maxContentLength: 30000,
    intentClassificationCharLimit: 0,
    logLevel: 'warn',
    llmLogPayloads: false,
    db: { type: 'sqlite', sqlitePath: ':memory:' },
    providerBaseUrls: {
      deepseek: 'https://api.deepseek.com/v1',
      ollama: 'http://localhost:11434/v1',
    },
    authPassword: undefined,
    language: 'en',
    serverSocketTimeoutMs: 0,
    trustProxy: false,
    nodeEnv: 'test',
  };
}

// ─── Helpers ───────────────────────────────────────────────────

let testDB: TestDB;

function makeWorkerDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  const rawDb = getRawDatabase(testDB.db);
  const taskRepo = new SqliteTaskRepository(testDB.db, rawDb);
  const sourceRepo = new SqliteSourceRepository(testDB.db);
  const pipeline: Pipeline = { process: vi.fn().mockResolvedValue({}) };

  return {
    taskRepo,
    sourceRepo,
    workerInterval: 1, // 1 second for fast tests
    logger: mockLogger,
    pipeline,
    config: makeTestConfig(),
    db: testDB.db,
    ...overrides,
  };
}

function insertSourceAndTask(
  taskStatus: TaskStatus = 'pending',
  sourceStatus: SourceStatus = 'processing',
  opts: { inputType?: InputType | null } = {},
): { sourceId: number; taskId: number } {
  const rawDb = getRawDatabase(testDB.db);
  const sourceRepo = new SqliteSourceRepository(testDB.db);
  const taskRepo = new SqliteTaskRepository(testDB.db, rawDb);

  const source = sourceRepo.create({
    kind: 'external',
    normalizedUrl: `https://example.com/${Date.now()}-${Math.random()}`,
    originalUrl: `https://example.com/${Date.now()}`,
  });
  if (sourceStatus !== 'processing') {
    sourceRepo.updateStatus(source.id, sourceStatus);
  }

  const task = taskRepo.create({
    sourceId: source.id,
    type: 'pipeline',
    inputType: opts.inputType ?? 'url',
  });

  // Manually set task status if not 'pending' (create defaults to pending)
  if (taskStatus === 'done') {
    rawDb
      .prepare(`UPDATE processing_tasks SET status = 'done', result = '{}' WHERE id = ?`)
      .run(task.id);
  } else if (taskStatus === 'error') {
    rawDb
      .prepare(
        `UPDATE processing_tasks SET status = 'error', error_message = 'test error', error_kind = 'unknown' WHERE id = ?`,
      )
      .run(task.id);
  } else if (taskStatus !== 'pending') {
    rawDb.prepare(`UPDATE processing_tasks SET status = ? WHERE id = ?`).run(taskStatus, task.id);
  }

  return { sourceId: source.id, taskId: task.id };
}

// ─── Test Suite ────────────────────────────────────────────────

describe('Worker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    testDB = createTestDB();
    // Clean globalThis worker flags
    delete (globalThis as any).__goldpan_worker_started;
    delete (globalThis as any).__goldpan_worker_timer;
    delete (globalThis as any).__goldpan_worker_inflight;
  });

  afterEach(async () => {
    await stopWorker();
    vi.useRealTimers();
    vi.clearAllMocks();
    testDB.cleanup();
    delete (globalThis as any).__goldpan_worker_started;
    delete (globalThis as any).__goldpan_worker_timer;
    delete (globalThis as any).__goldpan_worker_inflight;
  });

  // ─── startWorker ──────────────────────────────────────────

  describe('startWorker', () => {
    it('sets globalThis flag', () => {
      const deps = makeWorkerDeps();
      startWorker(deps);
      expect((globalThis as any).__goldpan_worker_started).toBe(true);
    });

    it('is idempotent (second call is no-op)', () => {
      const deps = makeWorkerDeps();
      startWorker(deps);
      const timer1 = (globalThis as any).__goldpan_worker_timer;

      startWorker(deps);
      const timer2 = (globalThis as any).__goldpan_worker_timer;

      expect(timer1).toBe(timer2);
    });

    it('crash recovery resets processing tasks to pending', () => {
      const { taskId } = insertSourceAndTask('processing');
      const rawDb = getRawDatabase(testDB.db);
      const taskRepo = new SqliteTaskRepository(testDB.db, rawDb);

      const deps = makeWorkerDeps({ taskRepo });
      startWorker(deps);

      const task = taskRepo.getById(taskId);
      expect(task?.status).toBe('pending');
    });

    it('crash recovery preserves inputType=url, clears text/opinion', () => {
      const { taskId: urlTaskId } = insertSourceAndTask('processing', 'processing', {
        inputType: 'url',
      });
      const { taskId: textTaskId } = insertSourceAndTask('processing', 'processing', {
        inputType: 'text',
      });
      const { taskId: opinionTaskId } = insertSourceAndTask('processing', 'processing', {
        inputType: 'opinion',
      });

      const rawDb = getRawDatabase(testDB.db);
      const taskRepo = new SqliteTaskRepository(testDB.db, rawDb);
      const deps = makeWorkerDeps({ taskRepo });
      startWorker(deps);

      expect(taskRepo.getById(urlTaskId)?.inputType).toBe('url');
      expect(taskRepo.getById(textTaskId)?.inputType).toBeNull();
      expect(taskRepo.getById(opinionTaskId)?.inputType).toBeNull();
    });

    it('does not reset done/error tasks during crash recovery', () => {
      const { taskId: doneTaskId } = insertSourceAndTask('done');
      const { taskId: errorTaskId } = insertSourceAndTask('error');

      const rawDb = getRawDatabase(testDB.db);
      const taskRepo = new SqliteTaskRepository(testDB.db, rawDb);
      const deps = makeWorkerDeps({ taskRepo });
      startWorker(deps);

      expect(taskRepo.getById(doneTaskId)?.status).toBe('done');
      expect(taskRepo.getById(errorTaskId)?.status).toBe('error');
    });
  });

  // ─── stopWorker ───────────────────────────────────────────

  describe('stopWorker', () => {
    it('clears interval and resets globalThis', async () => {
      const deps = makeWorkerDeps();
      startWorker(deps);
      expect((globalThis as any).__goldpan_worker_started).toBe(true);

      await stopWorker();
      expect((globalThis as any).__goldpan_worker_started).toBeUndefined();
      expect((globalThis as any).__goldpan_worker_timer).toBeUndefined();
    });

    it('is safe to call when not running', async () => {
      await expect(stopWorker()).resolves.toBeUndefined();
    });
  });

  // ─── Polling ──────────────────────────────────────────────

  describe('polling loop', () => {
    it('calls pipeline.process with correct PipelineContext', async () => {
      const { sourceId, taskId } = insertSourceAndTask('pending');
      const deps = makeWorkerDeps();
      startWorker(deps);

      await vi.advanceTimersByTimeAsync(1000);

      const process = deps.pipeline.process as ReturnType<typeof vi.fn>;
      expect(process).toHaveBeenCalledTimes(1);

      const ctx = process.mock.calls[0][0];
      expect(ctx.task.id).toBe(taskId);
      expect(ctx.source.id).toBe(sourceId);
      expect(ctx.config).toEqual(deps.config);
      expect(ctx.inputType).toBe('url');
      expect(ctx.content).toBeNull();
      expect(ctx.classification).toBeNull();
      expect(ctx.points).toEqual([]);
      expect(ctx.matchingOutput).toBeNull();
      expect(ctx.entityJudgments).toEqual([]);
      expect(ctx.verifierRejections).toEqual([]);
      expect(ctx.validationResult).toBeNull();
      expect(ctx.validationWarnings).toEqual([]);
    });

    it('does NOT write task/source status on success (delegates to pipeline)', async () => {
      insertSourceAndTask('pending');
      const rawDb = getRawDatabase(testDB.db);
      const taskRepo = new SqliteTaskRepository(testDB.db, rawDb);
      const sourceRepo = new SqliteSourceRepository(testDB.db);

      const markDoneSpy = vi.spyOn(taskRepo, 'markDone');
      const markErrorSpy = vi.spyOn(taskRepo, 'markError');
      const updateStatusSpy = vi.spyOn(sourceRepo, 'updateStatus');

      const deps = makeWorkerDeps({ taskRepo, sourceRepo });
      startWorker(deps);

      await vi.advanceTimersByTimeAsync(1000);

      // Worker should NOT call these — pipeline orchestrator handles them
      expect(markDoneSpy).not.toHaveBeenCalled();
      expect(markErrorSpy).not.toHaveBeenCalled();
      expect(updateStatusSpy).not.toHaveBeenCalled();
    });

    it('skips when task already processing (slow pipeline)', async () => {
      insertSourceAndTask('pending');
      const deps = makeWorkerDeps();

      let releaseSlow: () => void;
      const slowPipeline = new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      (deps.pipeline.process as ReturnType<typeof vi.fn>).mockImplementation(() => slowPipeline);

      startWorker(deps);

      // First poll: claims task, starts pipeline
      await vi.advanceTimersByTimeAsync(1000);
      expect(deps.pipeline.process as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);

      // Insert another pending task
      insertSourceAndTask('pending');

      // Second poll: should skip because hasProcessingTask() returns true
      await vi.advanceTimersByTimeAsync(1000);
      expect(deps.pipeline.process as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);

      releaseSlow!();
      await vi.advanceTimersByTimeAsync(1000);
    });

    it('does nothing when no pending tasks', async () => {
      const deps = makeWorkerDeps();
      startWorker(deps);

      await vi.advanceTimersByTimeAsync(1000);

      expect(deps.pipeline.process as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });

    it('marks task as error when source is missing', async () => {
      const rawDb = getRawDatabase(testDB.db);
      const taskRepo = new SqliteTaskRepository(testDB.db, rawDb);

      // Insert a source, create a task, then delete the source (disable FK temporarily)
      const { taskId } = insertSourceAndTask('pending');
      rawDb.exec('PRAGMA foreign_keys = OFF');
      rawDb.prepare('DELETE FROM sources').run();
      rawDb.exec('PRAGMA foreign_keys = ON');

      const deps = makeWorkerDeps({ taskRepo });
      startWorker(deps);
      await vi.advanceTimersByTimeAsync(1000);

      const task = taskRepo.getById(taskId);
      expect(task?.status).toBe('error');
      expect(task?.errorMessage).toContain('not found');
      expect(deps.pipeline.process as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });

    it('does NOT duplicate state write on PipelineError (orchestrator handled it)', async () => {
      const { taskId } = insertSourceAndTask('pending');
      const rawDb = getRawDatabase(testDB.db);
      const taskRepo = new SqliteTaskRepository(testDB.db, rawDb);
      const sourceRepo = new SqliteSourceRepository(testDB.db);

      const pipelineError = new PipelineError('test error', 'classifying', 'unknown');
      // Simulate realistic orchestrator: it persists error state THEN re-throws
      const deps = makeWorkerDeps({
        taskRepo,
        sourceRepo,
        pipeline: {
          process: vi.fn().mockImplementation(async (ctx: PipelineContext) => {
            taskRepo.markError(ctx.task.id, 'classifying', 'test error', 'unknown');
            sourceRepo.updateStatus(ctx.source.id, 'failed');
            throw pipelineError;
          }),
        },
      });

      const markErrorSpy = vi.spyOn(taskRepo, 'markError');
      const updateStatusSpy = vi.spyOn(sourceRepo, 'updateStatus');

      startWorker(deps);
      await vi.advanceTimersByTimeAsync(1000);

      // Orchestrator called markError + updateStatus once; worker's safety net
      // sees status='error' (not 'processing') so does NOT duplicate the write
      expect(markErrorSpy).toHaveBeenCalledTimes(1); // Only the orchestrator's call
      expect(updateStatusSpy).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalled();

      const task = taskRepo.getById(taskId);
      expect(task?.status).toBe('error');
    });

    it('safety net persists state when orchestrator fails to do so (PipelineError)', async () => {
      const { taskId, sourceId } = insertSourceAndTask('pending');
      const rawDb = getRawDatabase(testDB.db);
      const taskRepo = new SqliteTaskRepository(testDB.db, rawDb);
      const sourceRepo = new SqliteSourceRepository(testDB.db);

      const pipelineError = new PipelineError('LLM timeout', 'extracting', 'timeout');
      // Simulate orchestrator FAILING to persist state (e.g. disk full during markError)
      const deps = makeWorkerDeps({
        taskRepo,
        sourceRepo,
        pipeline: {
          process: vi.fn().mockRejectedValue(pipelineError),
        },
      });

      startWorker(deps);
      await vi.advanceTimersByTimeAsync(1000);

      // Task was still 'processing' (orchestrator didn't persist) → safety net kicks in
      const task = taskRepo.getById(taskId);
      expect(task?.status).toBe('error');
      expect(task?.errorMessage).toContain('LLM timeout');
      expect(task?.pipelineStep).toBe('extracting');

      const source = sourceRepo.getById(sourceId);
      expect(source?.status).toBe('failed');
    });

    it('persists error state for unexpected non-PipelineError crashes (safety net)', async () => {
      const { taskId, sourceId } = insertSourceAndTask('pending');
      const rawDb = getRawDatabase(testDB.db);
      const taskRepo = new SqliteTaskRepository(testDB.db, rawDb);
      const sourceRepo = new SqliteSourceRepository(testDB.db);

      const deps = makeWorkerDeps({
        taskRepo,
        sourceRepo,
        pipeline: {
          process: vi.fn().mockRejectedValue(new TypeError('unexpected crash')),
        },
      });

      startWorker(deps);
      await vi.advanceTimersByTimeAsync(1000);

      const task = taskRepo.getById(taskId);
      expect(task?.status).toBe('error');
      expect(task?.errorMessage).toContain('unexpected crash');

      const source = sourceRepo.getById(sourceId);
      expect(source?.status).toBe('failed');
    });

    it('processes tasks FIFO (oldest first)', async () => {
      // Insert two tasks — first should be processed first
      const { taskId: firstTaskId } = insertSourceAndTask('pending');
      const { taskId: secondTaskId } = insertSourceAndTask('pending');

      const rawDb = getRawDatabase(testDB.db);
      const taskRepo = new SqliteTaskRepository(testDB.db, rawDb);
      // Mock pipeline that marks the task as done (simulating orchestrator behavior)
      const pipeline: Pipeline = {
        process: vi.fn().mockImplementation(async (ctx) => {
          taskRepo.markDone(ctx.task.id, JSON.stringify({ status: 'done' }));
          return ctx;
        }),
      };

      const deps = makeWorkerDeps({ taskRepo, pipeline });
      startWorker(deps);

      // Immediate poll (setTimeout(0)) + first interval tick both fire
      await vi.advanceTimersByTimeAsync(1000);

      const process = deps.pipeline.process as ReturnType<typeof vi.fn>;
      expect(process).toHaveBeenCalledTimes(2);
      expect(process.mock.calls[0][0].task.id).toBe(firstTaskId);
      expect(process.mock.calls[1][0].task.id).toBe(secondTaskId);
    });

    it('claims exactly one task per poll cycle', async () => {
      insertSourceAndTask('pending');
      insertSourceAndTask('pending');
      insertSourceAndTask('pending');

      const deps = makeWorkerDeps();
      startWorker(deps);

      await vi.advanceTimersByTimeAsync(1000);

      const process = deps.pipeline.process as ReturnType<typeof vi.fn>;
      expect(process).toHaveBeenCalledTimes(1);
    });
  });

  describe('drainAndStop', () => {
    it('waits for in-flight pipeline to complete', async () => {
      vi.useRealTimers();

      let pipelineResolve: () => void;
      const pipelinePromise = new Promise<void>((resolve) => {
        pipelineResolve = resolve;
      });

      const { drainAndStop } = await import('../../src/worker/worker');

      globalThis.__goldpan_worker_started = true;
      globalThis.__goldpan_worker_inflight = pipelinePromise;

      let drained = false;
      const drainPromise = drainAndStop().then(() => {
        drained = true;
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(drained).toBe(false);

      pipelineResolve!();
      await drainPromise;

      expect(drained).toBe(true);
      expect(globalThis.__goldpan_worker_started).toBeUndefined();
      expect(globalThis.__goldpan_worker_timer).toBeUndefined();
    });
  });
});
