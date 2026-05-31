import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRawDatabase } from '../../../src/db/connection.js';
import { SqliteSourceRepository } from '../../../src/db/repositories/source.repository.js';
import { SqliteTaskRepository } from '../../../src/db/repositories/task.repository.js';
import { createTestDB, type TestDB } from '../../helpers/test-db.js';

describe('TaskRepository', () => {
  let t: TestDB;
  let repo: SqliteTaskRepository;
  let srcRepo: SqliteSourceRepository;
  let defaultSourceId: number;

  beforeEach(() => {
    t = createTestDB();
    repo = new SqliteTaskRepository(t.db, getRawDatabase(t.db));
    srcRepo = new SqliteSourceRepository(t.db);
    const src = srcRepo.create({ kind: 'user', rawContent: 'test input' });
    defaultSourceId = src.id;
  });

  afterEach(() => {
    t.cleanup();
  });

  describe('create', () => {
    it('creates task with pending status', () => {
      const task = repo.create({
        sourceId: defaultSourceId,
        type: 'pipeline',
        inputType: 'url',
      });
      expect(task.id).toBeGreaterThan(0);
      expect(task.status).toBe('pending');
      expect(task.inputType).toBe('url');
      expect(task.type).toBe('pipeline');
      expect(task.sourceId).toBe(defaultSourceId);
    });

    it('creates task without inputType (determined later by classifying)', () => {
      const task = repo.create({
        sourceId: defaultSourceId,
        type: 'pipeline',
      });
      expect(task.inputType).toBeNull();
    });
  });

  describe('claimNextPending', () => {
    it('claims oldest pending task (FIFO)', () => {
      const src2 = srcRepo.create({ kind: 'user', rawContent: 'second' });
      repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      repo.create({ sourceId: src2.id, type: 'pipeline' });

      const claimed = repo.claimNextPending();
      expect(claimed).toBeDefined();
      expect(claimed?.sourceId).toBe(defaultSourceId);
      expect(claimed?.status).toBe('processing');
    });

    it('returns undefined when no pending tasks', () => {
      const claimed = repo.claimNextPending();
      expect(claimed).toBeUndefined();
    });

    it('does not claim already processing tasks', () => {
      repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      repo.claimNextPending();
      const claimed = repo.claimNextPending();
      expect(claimed).toBeUndefined();
    });

    it('claim is atomic', () => {
      repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      const claimed = repo.claimNextPending();
      expect(claimed).toBeDefined();
      const second = repo.claimNextPending();
      expect(second).toBeUndefined();
    });
  });

  describe('markDone', () => {
    it('marks task as done with result JSON', () => {
      const task = repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      repo.claimNextPending();
      const resultJson = JSON.stringify({ accepted: 5, skipped: 2 });
      repo.markDone(task.id, resultJson);
      const updated = repo.getById(task.id);
      expect(updated?.status).toBe('done');
      expect(updated?.result).toBe(resultJson);
    });
  });

  describe('markDone — precondition', () => {
    it('rejects markDone for pending task', () => {
      const task = repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      expect(() => repo.markDone(task.id, '{}')).toThrow(/only processing tasks/i);
    });

    it('rejects markDone for error task', () => {
      const task = repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      repo.claimNextPending();
      repo.markError(task.id, 'extracting', 'timeout', 'unknown');
      expect(() => repo.markDone(task.id, '{}')).toThrow(/only processing tasks/i);
    });

    it('rejects markDone for already-done task', () => {
      const task = repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      repo.claimNextPending();
      repo.markDone(task.id, '{"a":1}');
      expect(() => repo.markDone(task.id, '{"a":2}')).toThrow(/only processing tasks/i);
    });
  });

  describe('markError', () => {
    it('marks task as error with step and message', () => {
      const task = repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      repo.claimNextPending();
      repo.markError(task.id, 'extracting', 'LLM timeout after 30s', 'timeout');
      const updated = repo.getById(task.id);
      expect(updated?.status).toBe('error');
      expect(updated?.pipelineStep).toBe('extracting');
      expect(updated?.errorMessage).toBe('LLM timeout after 30s');
      expect(updated?.errorKind).toBe('timeout');
    });

    it('accepts null pipelineStep for pre-pipeline errors', () => {
      const task = repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      repo.claimNextPending();
      repo.markError(task.id, null, 'failed before any pipeline step', 'unknown');
      const updated = repo.getById(task.id);
      expect(updated?.status).toBe('error');
      expect(updated?.pipelineStep).toBeNull();
    });

    it('rejects markError for done task (precondition)', () => {
      const task = repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      repo.claimNextPending();
      repo.markDone(task.id, '{"a":1}');
      expect(() => repo.markError(task.id, 'extracting', 'should fail', 'unknown')).toThrow(
        /Cannot mark error.*status 'done'/,
      );
    });

    it('rejects markError for non-existent task', () => {
      expect(() => repo.markError(99999, 'extracting', 'not found', 'unknown')).toThrow(
        /Task not found/,
      );
    });
  });

  describe('updatePipelineStep', () => {
    it('tracks current pipeline progress', () => {
      const task = repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      repo.claimNextPending();
      repo.updatePipelineStep(task.id, 'classifying');
      const updated = repo.getById(task.id);
      expect(updated?.pipelineStep).toBe('classifying');
    });
  });

  describe('updateInputType', () => {
    it('sets inputType after classifying step', () => {
      const task = repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      repo.claimNextPending();
      repo.updateInputType(task.id, 'text');
      const updated = repo.getById(task.id);
      expect(updated?.inputType).toBe('text');
    });
  });

  describe('resetForRetry', () => {
    it('resets error task to pending', () => {
      const task = repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      repo.claimNextPending();
      repo.markError(task.id, 'matching', 'API error', 'unknown');
      repo.resetForRetry(task.id);
      const updated = repo.getById(task.id);
      expect(updated?.status).toBe('pending');
      expect(updated?.errorMessage).toBeNull();
      expect(updated?.errorKind).toBeNull();
      expect(updated?.pipelineStep).toBeNull();
    });

    it('preserves inputType=url on retry', () => {
      const task = repo.create({ sourceId: defaultSourceId, type: 'pipeline', inputType: 'url' });
      repo.claimNextPending();
      repo.markError(task.id, 'collecting', 'timeout', 'timeout');
      repo.resetForRetry(task.id);
      const updated = repo.getById(task.id);
      expect(updated?.inputType).toBe('url');
    });

    it('preserves inputType=opinion on retry', () => {
      // `record_thought` submits set inputType='opinion' to lock the
      // opinion-only extraction path. The retry must keep that intent — a
      // null reset would let classifying re-classify the same text as
      // 'text' on the next run and silently drop the user-marked opinion.
      const task = repo.create({
        sourceId: defaultSourceId,
        type: 'pipeline',
        inputType: 'opinion',
      });
      repo.claimNextPending();
      repo.markError(task.id, 'extracting', 'LLM error', 'unknown');
      repo.resetForRetry(task.id);
      const updated = repo.getById(task.id);
      expect(updated?.inputType).toBe('opinion');
    });

    it('clears LLM-determined inputType=text on retry', () => {
      const task = repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      repo.claimNextPending();
      repo.updateInputType(task.id, 'text');
      repo.markError(task.id, 'extracting', 'LLM error', 'unknown');
      repo.resetForRetry(task.id);
      const updated = repo.getById(task.id);
      expect(updated?.inputType).toBeNull();
    });

    it('rejects resetForRetry for pending task', () => {
      const task = repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      expect(() => repo.resetForRetry(task.id)).toThrow(/only error tasks/i);
    });

    it('rejects resetForRetry for processing task', () => {
      const task = repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      repo.claimNextPending();
      expect(() => repo.resetForRetry(task.id)).toThrow(/only error tasks/i);
    });

    it('rejects resetForRetry for done task', () => {
      const task = repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      repo.claimNextPending();
      repo.markDone(
        task.id,
        JSON.stringify({ extracted: 1, accepted: 1, rejected: 0, skipped: 0 }),
      );
      expect(() => repo.resetForRetry(task.id)).toThrow(/only error tasks/i);
    });

    it('rejects resetForRetry for non-existent task', () => {
      expect(() => repo.resetForRetry(99999)).toThrow();
    });
  });

  describe('resetAllProcessing (crash recovery)', () => {
    it('resets stuck processing tasks to pending', () => {
      const src2 = srcRepo.create({ kind: 'user', rawContent: 'second' });
      repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      repo.create({ sourceId: src2.id, type: 'pipeline' });
      repo.claimNextPending();
      repo.claimNextPending();
      const resetCount = repo.resetAllProcessing();
      expect(resetCount).toBe(2);
      expect(repo.claimNextPending()).toBeDefined();
      expect(repo.claimNextPending()).toBeDefined();
    });

    it('does not touch pending or done tasks', () => {
      const src2 = srcRepo.create({ kind: 'user', rawContent: 'second' });
      repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      const task2 = repo.create({ sourceId: src2.id, type: 'pipeline' });
      repo.claimNextPending();
      repo.claimNextPending();
      repo.markDone(task2.id, JSON.stringify({ ok: true }));
      const resetCount = repo.resetAllProcessing();
      expect(resetCount).toBe(1);
      const doneTask = repo.getById(task2.id);
      expect(doneTask?.status).toBe('done');
    });

    it('preserves inputType=url, clears LLM-determined types', () => {
      const extSrc = srcRepo.create({
        kind: 'external',
        normalizedUrl: 'https://example.com/reset-test',
        originalUrl: 'https://example.com/reset-test',
      });
      const urlTask = repo.create({ sourceId: extSrc.id, type: 'pipeline', inputType: 'url' });
      const textTask = repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      repo.claimNextPending();
      repo.claimNextPending();
      repo.updateInputType(textTask.id, 'text');
      repo.resetAllProcessing();
      expect(repo.getById(urlTask.id)?.inputType).toBe('url');
      expect(repo.getById(textTask.id)?.inputType).toBeNull();
    });
  });

  describe('hasProcessingTask', () => {
    it('returns false when no processing tasks', () => {
      repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      expect(repo.hasProcessingTask()).toBe(false);
    });

    it('returns true when a task is processing', () => {
      repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      repo.claimNextPending();
      expect(repo.hasProcessingTask()).toBe(true);
    });
  });

  describe('getRecent', () => {
    it('returns recent tasks newest first', () => {
      const src2 = srcRepo.create({ kind: 'user', rawContent: 'second' });
      repo.create({ sourceId: defaultSourceId, type: 'pipeline' });
      repo.create({ sourceId: src2.id, type: 'pipeline' });
      const recent = repo.getRecent(10);
      expect(recent).toHaveLength(2);
      expect(recent[0].id).toBeGreaterThan(recent[1].id);
    });
  });
});
