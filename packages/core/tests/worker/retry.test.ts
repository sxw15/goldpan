import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRawDatabase } from '../../src/db/connection.js';
import { SqliteSourceRepository } from '../../src/db/repositories/source.repository.js';
import { SqliteTaskRepository } from '../../src/db/repositories/task.repository.js';
import type { InputType, SourceStatus, TaskStatus } from '../../src/db/repositories/types.js';
import * as schema from '../../src/db/schema.js';
import type { RetryDeps } from '../../src/worker/retry.js';
import { createTestDB, type TestDB } from '../helpers/test-db.js';

describe('retryTask', () => {
  let testDB: TestDB;
  let taskRepo: SqliteTaskRepository;
  let sourceRepo: SqliteSourceRepository;
  let deps: RetryDeps;
  let retryTask: (taskId: number, deps: RetryDeps) => Promise<void>;

  // ─── helpers ────────────────────────────────────────────────

  function insertSourceAndTask(
    taskStatus: TaskStatus = 'error',
    sourceStatus: SourceStatus = 'failed',
    opts: {
      inputType?: InputType | null;
      kind?: 'external' | 'user';
      normalizedUrl?: string;
    } = {},
  ): { sourceId: number; taskId: number } {
    const rawDb = getRawDatabase(testDB.db);
    const kind = opts.kind ?? 'external';
    const url =
      kind === 'external'
        ? (opts.normalizedUrl ?? `https://example.com/${Date.now()}-${Math.random()}`)
        : undefined;

    const source =
      kind === 'external'
        ? sourceRepo.create({
            kind: 'external',
            normalizedUrl: url!,
            originalUrl: url!,
          })
        : sourceRepo.create({
            kind: 'user',
            rawContent: 'user provided content',
          });

    if (sourceStatus !== 'processing') {
      sourceRepo.updateStatus(source.id, sourceStatus);
    }

    const task = taskRepo.create({
      sourceId: source.id,
      type: 'pipeline',
      inputType: opts.inputType ?? (kind === 'external' ? 'url' : undefined),
    });

    if (taskStatus === 'error') {
      rawDb
        .prepare(
          `UPDATE processing_tasks SET status = 'error', error_message = 'test error', pipeline_step = 'classifying', error_kind = 'unknown' WHERE id = ?`,
        )
        .run(task.id);
    } else if (taskStatus === 'processing') {
      rawDb
        .prepare(
          `UPDATE processing_tasks SET status = 'processing', pipeline_step = 'classifying' WHERE id = ?`,
        )
        .run(task.id);
    } else if (taskStatus === 'done') {
      rawDb
        .prepare(
          `UPDATE processing_tasks SET status = 'done', result = '{"done":true}' WHERE id = ?`,
        )
        .run(task.id);
    }

    return { sourceId: source.id, taskId: task.id };
  }

  // ─── setup / teardown ──────────────────────────────────────

  beforeEach(async () => {
    testDB = createTestDB();
    const rawDb = getRawDatabase(testDB.db);
    taskRepo = new SqliteTaskRepository(testDB.db, rawDb);
    sourceRepo = new SqliteSourceRepository(testDB.db);
    deps = { db: testDB.db, taskRepo, sourceRepo };

    const mod = await import('../../src/worker/retry.js');
    retryTask = mod.retryTask;
  });

  afterEach(() => {
    testDB.cleanup();
  });

  // ─── precondition checks ──────────────────────────────────

  describe('precondition checks', () => {
    it('rejects retry on non-existent task', async () => {
      await expect(retryTask(99999, deps)).rejects.toThrow(/not found/i);
    });

    it('rejects retry on pending task', async () => {
      const { taskId } = insertSourceAndTask('pending');
      await expect(retryTask(taskId, deps)).rejects.toThrow(/only.*error/i);
    });

    it('rejects retry on processing task', async () => {
      const { taskId } = insertSourceAndTask('processing');
      await expect(retryTask(taskId, deps)).rejects.toThrow(/only.*error/i);
    });

    it('rejects retry on done task', async () => {
      const { taskId } = insertSourceAndTask('done');
      await expect(retryTask(taskId, deps)).rejects.toThrow(/only.*error/i);
    });
  });

  // ─── URL conflict checks ──────────────────────────────────

  describe('URL conflict checks', () => {
    it('rejects when same URL has an active processing source', async () => {
      const sharedUrl = 'https://example.com/shared-article';

      // Create our error task first (source goes processing→failed)
      const { taskId } = insertSourceAndTask('error', 'failed', {
        normalizedUrl: sharedUrl,
      });

      // Now create another source with same URL — it starts as processing
      sourceRepo.create({
        kind: 'external',
        normalizedUrl: sharedUrl,
        originalUrl: sharedUrl,
      });

      await expect(retryTask(taskId, deps)).rejects.toThrow(/active/i);
    });

    it('rejects when same URL has a confirmed source', async () => {
      const sharedUrl = 'https://example.com/shared-confirmed';

      // Create our error task first (source goes processing→failed)
      const { taskId } = insertSourceAndTask('error', 'failed', {
        normalizedUrl: sharedUrl,
      });

      // Create another source with same URL, then confirm it
      const conflicting = sourceRepo.create({
        kind: 'external',
        normalizedUrl: sharedUrl,
        originalUrl: sharedUrl,
      });
      sourceRepo.updateStatus(conflicting.id, 'confirmed');

      await expect(retryTask(taskId, deps)).rejects.toThrow(/active/i);
    });

    it('allows retry when same URL only has failed sources', async () => {
      const sharedUrl = 'https://example.com/shared-failed';

      // Another source with same URL, but failed
      const otherSource = sourceRepo.create({
        kind: 'external',
        normalizedUrl: sharedUrl,
        originalUrl: sharedUrl,
      });
      sourceRepo.updateStatus(otherSource.id, 'failed');

      // Our error task with the same URL
      const { taskId } = insertSourceAndTask('error', 'failed', {
        normalizedUrl: sharedUrl,
      });

      await expect(retryTask(taskId, deps)).resolves.toBeUndefined();
    });

    it('skips URL conflict check for user-kind sources', async () => {
      const { taskId } = insertSourceAndTask('error', 'failed', {
        kind: 'user',
      });

      await expect(retryTask(taskId, deps)).resolves.toBeUndefined();
    });

    it('rolls back both task and source on URL conflict error', async () => {
      const sharedUrl = 'https://example.com/shared-rollback';

      // Create our error task (source goes processing→failed)
      const { taskId, sourceId } = insertSourceAndTask('error', 'failed', {
        normalizedUrl: sharedUrl,
      });

      // Create another active source with the same URL
      sourceRepo.create({
        kind: 'external',
        normalizedUrl: sharedUrl,
        originalUrl: sharedUrl,
      });

      // Attempt retry — should fail due to URL conflict
      await expect(retryTask(taskId, deps)).rejects.toThrow(/active/i);

      // Verify neither task nor source was changed
      const task = testDB.db
        .select()
        .from(schema.processingTasks)
        .where(eq(schema.processingTasks.id, taskId))
        .get();
      const source = testDB.db
        .select()
        .from(schema.sources)
        .where(eq(schema.sources.id, sourceId))
        .get();

      expect(task?.status).toBe('error');
      expect(task?.errorMessage).toBe('test error');
      expect(source?.status).toBe('failed');
    });
  });

  // ─── successful retry ─────────────────────────────────────

  describe('successful retry', () => {
    it('resets task fields correctly', async () => {
      const { taskId } = insertSourceAndTask('error', 'failed');

      await retryTask(taskId, deps);

      const task = testDB.db
        .select()
        .from(schema.processingTasks)
        .where(eq(schema.processingTasks.id, taskId))
        .get();

      expect(task).toBeDefined();
      expect(task?.status).toBe('pending');
      expect(task?.pipelineStep).toBeNull();
      expect(task?.errorMessage).toBeNull();
      expect(task?.result).toBeNull();
    });

    it('resets source status to processing', async () => {
      const { sourceId, taskId } = insertSourceAndTask('error', 'failed');

      await retryTask(taskId, deps);

      const source = testDB.db
        .select()
        .from(schema.sources)
        .where(eq(schema.sources.id, sourceId))
        .get();

      expect(source).toBeDefined();
      expect(source?.status).toBe('processing');
    });

    it('preserves inputType=url on retry', async () => {
      const { taskId } = insertSourceAndTask('error', 'failed', {
        inputType: 'url',
      });

      await retryTask(taskId, deps);

      const task = testDB.db
        .select()
        .from(schema.processingTasks)
        .where(eq(schema.processingTasks.id, taskId))
        .get();

      expect(task?.inputType).toBe('url');
    });

    it('clears LLM-determined inputType on retry (text)', async () => {
      const { taskId } = insertSourceAndTask('error', 'failed', {
        inputType: 'text',
      });

      await retryTask(taskId, deps);

      const task = testDB.db
        .select()
        .from(schema.processingTasks)
        .where(eq(schema.processingTasks.id, taskId))
        .get();

      expect(task?.inputType).toBeNull();
    });

    it('preserves inputType on retry (opinion)', async () => {
      // Opinion is locked by submit (`record_thought` intent) so retry must
      // not let classifying re-derive `text` and drop the opinion-only
      // extraction path. See task.repository.ts `resetForRetry`.
      const { taskId } = insertSourceAndTask('error', 'failed', {
        inputType: 'opinion',
      });

      await retryTask(taskId, deps);

      const task = testDB.db
        .select()
        .from(schema.processingTasks)
        .where(eq(schema.processingTasks.id, taskId))
        .get();

      expect(task?.inputType).toBe('opinion');
    });

    it('updates task and source in same transaction (atomicity)', async () => {
      const { sourceId, taskId } = insertSourceAndTask('error', 'failed');

      await retryTask(taskId, deps);

      const task = testDB.db
        .select()
        .from(schema.processingTasks)
        .where(eq(schema.processingTasks.id, taskId))
        .get();
      const source = testDB.db
        .select()
        .from(schema.sources)
        .where(eq(schema.sources.id, sourceId))
        .get();

      // Both must be updated together
      expect(task?.status).toBe('pending');
      expect(source?.status).toBe('processing');
    });

    it('updates updated_at timestamp', async () => {
      const { sourceId, taskId } = insertSourceAndTask('error', 'failed');

      // Read timestamps before retry
      const taskBefore = testDB.db
        .select()
        .from(schema.processingTasks)
        .where(eq(schema.processingTasks.id, taskId))
        .get();
      const sourceBefore = testDB.db
        .select()
        .from(schema.sources)
        .where(eq(schema.sources.id, sourceId))
        .get();

      await retryTask(taskId, deps);

      const taskAfter = testDB.db
        .select()
        .from(schema.processingTasks)
        .where(eq(schema.processingTasks.id, taskId))
        .get();
      const sourceAfter = testDB.db
        .select()
        .from(schema.sources)
        .where(eq(schema.sources.id, sourceId))
        .get();

      expect(taskAfter?.updatedAt).toBeDefined();
      expect(sourceAfter?.updatedAt).toBeDefined();
      // Timestamps should be at least as recent as before
      expect(taskAfter?.updatedAt >= taskBefore?.updatedAt).toBe(true);
      expect(sourceAfter?.updatedAt >= sourceBefore?.updatedAt).toBe(true);
    });
  });
});
