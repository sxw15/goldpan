import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRawDatabase } from '../../src/db/connection';
import { SqliteLlmCallRepository } from '../../src/db/repositories/llm-call.repository';
import { SqliteSourceRepository } from '../../src/db/repositories/source.repository';
import { SqliteTaskRepository } from '../../src/db/repositories/task.repository';
import { SqliteTaskLogRepository } from '../../src/db/repositories/task-log.repository';
import { llmCalls, taskLogs } from '../../src/db/schema';
import {
  clearTaskLogs,
  deleteTask,
  getRecentTasksWithSources,
  isRetryableTaskError,
  validateRetryPreconditions,
} from '../../src/operations/task-ops';
import { createTestDB, type TestDB } from '../helpers/test-db';

describe('task-ops', () => {
  let testDB: TestDB;
  let taskRepo: InstanceType<typeof SqliteTaskRepository>;
  let sourceRepo: InstanceType<typeof SqliteSourceRepository>;
  let taskLogRepo: InstanceType<typeof SqliteTaskLogRepository>;
  let llmCallRepo: InstanceType<typeof SqliteLlmCallRepository>;

  beforeEach(() => {
    testDB = createTestDB();
    const rawDb = getRawDatabase(testDB.db);
    taskRepo = new SqliteTaskRepository(testDB.db, rawDb);
    sourceRepo = new SqliteSourceRepository(testDB.db);
    taskLogRepo = new SqliteTaskLogRepository(testDB.db);
    llmCallRepo = new SqliteLlmCallRepository(testDB.db);
  });

  afterEach(() => {
    testDB.cleanup();
  });

  describe('getRecentTasksWithSources', () => {
    it('returns empty array when no tasks exist', () => {
      const result = getRecentTasksWithSources(taskRepo, sourceRepo, testDB.db);
      expect(result).toEqual([]);
    });

    it('returns tasks with their source data', () => {
      const source = sourceRepo.create({
        kind: 'external',
        originalUrl: 'https://example.com/article',
        normalizedUrl: 'example.com/article',
      });
      const task = taskRepo.create({ sourceId: source.id, type: 'pipeline' });

      const result = getRecentTasksWithSources(taskRepo, sourceRepo, testDB.db);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(task.id);
      expect(result[0].sourceId).toBe(source.id);
      expect(result[0].source?.originalUrl).toBe('https://example.com/article');
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        const s = sourceRepo.create({
          kind: 'user',
          rawContent: `content ${i}`,
        });
        taskRepo.create({ sourceId: s.id, type: 'pipeline' });
      }

      const result = getRecentTasksWithSources(taskRepo, sourceRepo, testDB.db, 3);
      expect(result).toHaveLength(3);
    });

    it('returns durationS computed from earliest/latest task_log timestamps', () => {
      const source = sourceRepo.create({ kind: 'user', rawContent: 'duration test' });
      const task = taskRepo.create({ sourceId: source.id, type: 'pipeline' });

      // Insert two task_logs spanning 5.5 seconds (sub-second precision via INTEGER ms).
      const startMs = Date.UTC(2026, 3, 28, 10, 0, 0, 0);
      testDB.db
        .insert(taskLogs)
        .values({
          taskId: task.id,
          step: 'collecting',
          event: 'start',
          timestamp: startMs,
        })
        .run();
      testDB.db
        .insert(taskLogs)
        .values({
          taskId: task.id,
          step: 'storing',
          event: 'end',
          timestamp: startMs + 5500,
        })
        .run();

      const result = getRecentTasksWithSources(taskRepo, sourceRepo, testDB.db);
      expect(result[0].durationS).not.toBeNull();
      expect(result[0].durationS!).toBeCloseTo(5.5, 1);
    });

    it('returns null durationS when no task_logs exist', () => {
      const source = sourceRepo.create({ kind: 'user', rawContent: 'no logs' });
      taskRepo.create({ sourceId: source.id, type: 'pipeline' });

      const result = getRecentTasksWithSources(taskRepo, sourceRepo, testDB.db);
      expect(result[0].durationS).toBeNull();
    });

    it('counts llm_calls and retries by source', () => {
      const source = sourceRepo.create({ kind: 'user', rawContent: 'llm test' });
      taskRepo.create({ sourceId: source.id, type: 'pipeline' });

      // 2 successful first-attempt calls + 1 retry (attempt 2) = 3 total, 1 retry.
      llmCallRepo.create({
        step: 'classifier',
        provider: 'openai',
        model: 'gpt-4',
        inputTokens: 100,
        outputTokens: 50,
        requestBody: '{}',
        responseBody: '{}',
        requestSchema: null,
        promptHash: 'h1',
        sourceId: source.id,
        outcome: 'success',
        failureKind: null,
        failureMessage: null,
        attemptNumber: 1,
      });
      llmCallRepo.create({
        step: 'extractor',
        provider: 'openai',
        model: 'gpt-4',
        inputTokens: 200,
        outputTokens: 80,
        requestBody: '{}',
        responseBody: '{}',
        requestSchema: null,
        promptHash: 'h2',
        sourceId: source.id,
        outcome: 'success',
        failureKind: null,
        failureMessage: null,
        attemptNumber: 1,
      });
      llmCallRepo.create({
        step: 'matcher',
        provider: 'openai',
        model: 'gpt-4',
        inputTokens: 150,
        outputTokens: 70,
        requestBody: '{}',
        responseBody: '{}',
        requestSchema: null,
        promptHash: 'h3',
        sourceId: source.id,
        outcome: 'success',
        failureKind: null,
        failureMessage: null,
        attemptNumber: 2,
      });

      const result = getRecentTasksWithSources(taskRepo, sourceRepo, testDB.db);
      expect(result[0].llmCount).toBe(3);
      expect(result[0].retryCount).toBe(1);
    });

    it('returns 0 counts when no llm_calls exist', () => {
      const source = sourceRepo.create({ kind: 'user', rawContent: 'no llm' });
      taskRepo.create({ sourceId: source.id, type: 'pipeline' });

      const result = getRecentTasksWithSources(taskRepo, sourceRepo, testDB.db);
      expect(result[0].llmCount).toBe(0);
      expect(result[0].retryCount).toBe(0);
    });

    it('aggregates per-task — does not bleed counts across tasks', () => {
      const sourceA = sourceRepo.create({ kind: 'user', rawContent: 'A' });
      const sourceB = sourceRepo.create({ kind: 'user', rawContent: 'B' });
      const taskA = taskRepo.create({ sourceId: sourceA.id, type: 'pipeline' });
      const taskB = taskRepo.create({ sourceId: sourceB.id, type: 'pipeline' });

      // taskA gets 1 log + 2 LLM calls
      const baseMs = Date.UTC(2026, 3, 28, 10, 0, 0, 0);
      testDB.db
        .insert(taskLogs)
        .values({
          taskId: taskA.id,
          step: 'collecting',
          event: 'start',
          timestamp: baseMs,
        })
        .run();
      testDB.db
        .insert(taskLogs)
        .values({
          taskId: taskA.id,
          step: 'storing',
          event: 'end',
          timestamp: baseMs + 2000,
        })
        .run();
      testDB.db
        .insert(llmCalls)
        .values({
          step: 'classifier',
          promptHash: 'a',
          sourceId: sourceA.id,
          attemptNumber: 1,
          timestamp: baseMs + 1000,
        })
        .run();
      testDB.db
        .insert(llmCalls)
        .values({
          step: 'extractor',
          promptHash: 'a2',
          sourceId: sourceA.id,
          attemptNumber: 1,
          timestamp: baseMs + 1500,
        })
        .run();

      // taskB gets a different number of LLM calls
      testDB.db
        .insert(llmCalls)
        .values({
          step: 'classifier',
          promptHash: 'b',
          sourceId: sourceB.id,
          attemptNumber: 1,
          timestamp: baseMs + 60_000,
        })
        .run();

      const result = getRecentTasksWithSources(taskRepo, sourceRepo, testDB.db);
      const byId = new Map(result.map((r) => [r.id, r]));
      expect(byId.get(taskA.id)?.llmCount).toBe(2);
      expect(byId.get(taskA.id)?.durationS).toBeCloseTo(2, 1);
      expect(byId.get(taskB.id)?.llmCount).toBe(1);
      expect(byId.get(taskB.id)?.durationS).toBeNull();
    });
  });

  describe('deleteTask', () => {
    it('returns not_found for non-existent task', () => {
      const result = deleteTask(999, testDB.db);
      expect(result).toEqual({ ok: false, code: 'not_found' });
    });

    it('returns is_processing for a processing task', () => {
      const source = sourceRepo.create({ kind: 'user', rawContent: 'test' });
      taskRepo.create({ sourceId: source.id, type: 'pipeline' });
      taskRepo.claimNextPending();

      const task = taskRepo.getRecent(1)[0];
      const result = deleteTask(task.id, testDB.db);
      expect(result).toEqual({ ok: false, code: 'is_processing' });
    });

    it('returns is_done for a completed task', () => {
      const source = sourceRepo.create({ kind: 'user', rawContent: 'test' });
      taskRepo.create({ sourceId: source.id, type: 'pipeline' });
      const claimed = taskRepo.claimNextPending()!;
      taskRepo.markDone(claimed.id, '{}');

      const result = deleteTask(claimed.id, testDB.db);
      expect(result).toEqual({ ok: false, code: 'is_done' });
    });

    it('deletes pending task and its orphaned source', () => {
      const source = sourceRepo.create({ kind: 'user', rawContent: 'test' });
      const task = taskRepo.create({ sourceId: source.id, type: 'pipeline' });

      const result = deleteTask(task.id, testDB.db);
      expect(result).toEqual({ ok: true });
      expect(taskRepo.getById(task.id)).toBeUndefined();
      expect(sourceRepo.getById(source.id)).toBeUndefined();
    });

    it('deletes error task but keeps confirmed source', () => {
      const source = sourceRepo.create({
        kind: 'external',
        originalUrl: 'https://example.com',
        normalizedUrl: 'example.com',
      });
      sourceRepo.updateStatus(source.id, 'confirmed');
      const task = taskRepo.create({ sourceId: source.id, type: 'pipeline' });
      taskRepo.markError(task.id, null, 'test error', 'unknown');

      const result = deleteTask(task.id, testDB.db);
      expect(result).toEqual({ ok: true });
      expect(taskRepo.getById(task.id)).toBeUndefined();
      expect(sourceRepo.getById(source.id)).toBeDefined();
    });
  });

  describe('clearTaskLogs', () => {
    it('returns not_found for non-existent task', () => {
      const result = clearTaskLogs(999, taskRepo, taskLogRepo);
      expect(result).toEqual({ ok: false, code: 'not_found' });
    });

    it('clears logs for an existing task', () => {
      const source = sourceRepo.create({ kind: 'user', rawContent: 'test' });
      const task = taskRepo.create({ sourceId: source.id, type: 'pipeline' });
      taskLogRepo.create({
        taskId: task.id,
        step: 'classifying',
        event: 'start',
        message: 'test',
      });

      expect(taskLogRepo.getByTaskId(task.id)).toHaveLength(1);
      const result = clearTaskLogs(task.id, taskRepo, taskLogRepo);
      expect(result).toEqual({ ok: true });
      expect(taskLogRepo.getByTaskId(task.id)).toHaveLength(0);
    });
  });

  describe('validateRetryPreconditions', () => {
    it('returns not_found for non-existent task', () => {
      const result = validateRetryPreconditions(999, taskRepo, sourceRepo);
      expect(result).toEqual({ ok: false, code: 'not_found' });
    });

    it('returns not_failed for non-error task', () => {
      const source = sourceRepo.create({ kind: 'user', rawContent: 'test' });
      taskRepo.create({ sourceId: source.id, type: 'pipeline' });
      const task = taskRepo.getRecent(1)[0];

      const result = validateRetryPreconditions(task.id, taskRepo, sourceRepo);
      expect(result).toEqual({ ok: false, code: 'not_failed' });
    });

    it('returns not_retryable for a content_policy failure', () => {
      const source = sourceRepo.create({ kind: 'user', rawContent: 'test' });
      const task = taskRepo.create({ sourceId: source.id, type: 'pipeline' });
      taskRepo.markError(task.id, null, 'blocked', 'content_policy');

      const result = validateRetryPreconditions(task.id, taskRepo, sourceRepo);
      expect(result).toEqual({ ok: false, code: 'not_retryable' });
    });

    it('returns not_retryable for a non-content_length content_validation failure', () => {
      const source = sourceRepo.create({ kind: 'user', rawContent: 'test' });
      const task = taskRepo.create({ sourceId: source.id, type: 'pipeline' });
      taskRepo.markError(task.id, 'content_validation', 'validation failed', 'unknown');

      const result = validateRetryPreconditions(task.id, taskRepo, sourceRepo);
      expect(result).toEqual({ ok: false, code: 'not_retryable' });
    });

    it('returns ok for a content_length failure (limits are user-configurable, retry can succeed)', () => {
      const source = sourceRepo.create({ kind: 'user', rawContent: 'test' });
      const task = taskRepo.create({ sourceId: source.id, type: 'pipeline' });
      taskRepo.markError(task.id, 'content_validation', 'too long', 'content_length');

      const result = validateRetryPreconditions(task.id, taskRepo, sourceRepo);
      expect(result.ok).toBe(true);
    });

    it('returns source_not_found when source is missing', () => {
      const source = sourceRepo.create({ kind: 'user', rawContent: 'test' });
      const task = taskRepo.create({ sourceId: source.id, type: 'pipeline' });
      taskRepo.markError(task.id, null, 'error', 'unknown');
      const rawDb = getRawDatabase(testDB.db);
      rawDb.exec('PRAGMA foreign_keys = OFF');
      rawDb.exec(`DELETE FROM sources WHERE id = ${source.id}`);
      rawDb.exec('PRAGMA foreign_keys = ON');

      const result = validateRetryPreconditions(task.id, taskRepo, sourceRepo);
      expect(result).toEqual({ ok: false, code: 'source_not_found' });
    });

    it('returns source_conflict when URL is taken by another source', () => {
      // Create the task's source first (starts as 'processing')
      const taskSource = sourceRepo.create({
        kind: 'external',
        originalUrl: 'https://example.com/original',
        normalizedUrl: 'example.com',
      });
      const task = taskRepo.create({ sourceId: taskSource.id, type: 'pipeline' });
      taskRepo.markError(task.id, null, 'error', 'unknown');
      // Mark task's source as failed so the partial unique index slot is freed
      sourceRepo.updateStatus(taskSource.id, 'failed');

      // Now create a conflicting source with the same normalized URL (starts as 'processing')
      sourceRepo.create({
        kind: 'external',
        originalUrl: 'https://example.com/other',
        normalizedUrl: 'example.com',
      });

      const result = validateRetryPreconditions(task.id, taskRepo, sourceRepo);
      expect(result).toEqual({ ok: false, code: 'source_conflict' });
    });

    it('returns ok with task and source for valid retry', () => {
      const source = sourceRepo.create({ kind: 'user', rawContent: 'test' });
      const task = taskRepo.create({ sourceId: source.id, type: 'pipeline' });
      taskRepo.markError(task.id, null, 'error', 'unknown');

      const result = validateRetryPreconditions(task.id, taskRepo, sourceRepo);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.task.id).toBe(task.id);
        expect(result.source.id).toBe(source.id);
      }
    });
  });

  describe('isRetryableTaskError', () => {
    it('treats content_policy as non-retryable regardless of step', () => {
      expect(isRetryableTaskError(null, 'content_policy')).toBe(false);
      expect(isRetryableTaskError('extracting', 'content_policy')).toBe(false);
    });

    it('treats non-content_length content_validation failures as non-retryable', () => {
      expect(isRetryableTaskError('content_validation', 'unknown')).toBe(false);
    });

    it('treats content_length as retryable (limits are user-configurable)', () => {
      // Surfaces at the content_validation step, but the min/max limits can be
      // adjusted in Settings, so a re-run after changing them genuinely succeeds.
      expect(isRetryableTaskError('content_validation', 'content_length')).toBe(true);
    });

    it('treats transient / extraction failures as retryable', () => {
      expect(isRetryableTaskError('extracting', 'timeout')).toBe(true);
      expect(isRetryableTaskError('extracting', 'rate_limit')).toBe(true);
      expect(isRetryableTaskError(null, 'unknown')).toBe(true);
    });
  });
});
