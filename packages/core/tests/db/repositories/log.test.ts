import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteKnowledgeRepository } from '../../../src/db/repositories/knowledge.repository.js';
import {
  SqliteEventLogRepository,
  SqliteSubmissionLogRepository,
} from '../../../src/db/repositories/log.repository.js';
import { SqliteSourceRepository } from '../../../src/db/repositories/source.repository.js';
import * as schema from '../../../src/db/schema.js';
import { createTestDB, type TestDB } from '../../helpers/test-db.js';

describe('EventLogRepository', () => {
  let t: TestDB;
  let repo: SqliteEventLogRepository;
  let srcRepo: SqliteSourceRepository;
  let knRepo: SqliteKnowledgeRepository;
  let defaultSourceId: number;

  beforeEach(() => {
    t = createTestDB();
    repo = new SqliteEventLogRepository(t.db);
    srcRepo = new SqliteSourceRepository(t.db);
    knRepo = new SqliteKnowledgeRepository(t.db);
    const src = srcRepo.create({ kind: 'user', rawContent: 'test' });
    defaultSourceId = src.id;
  });

  afterEach(() => {
    t.cleanup();
  });

  describe('create', () => {
    it('writes event log entry with action', () => {
      const entry = repo.create({
        sourceId: defaultSourceId,
        action: 'source_confirmed',
        summary: 'Source processed successfully',
      });
      expect(entry.id).toBeGreaterThan(0);
      expect(entry.action).toBe('source_confirmed');
      expect(entry.sourceId).toBe(defaultSourceId);
    });

    it('writes entity_created event with entityId', () => {
      const ent = knRepo.createEntity({ name: 'Test Entity' });
      const entry = repo.create({
        sourceId: defaultSourceId,
        entityId: ent.id,
        action: 'entity_created',
        summary: 'Created entity: Test Entity',
      });
      expect(entry.entityId).toBe(ent.id);
    });

    it('writes point_created event with pointId', () => {
      const ent = knRepo.createEntity({ name: 'Test' });
      const point = knRepo.createPoint('A fact', 'fact');
      const entry = repo.create({
        sourceId: defaultSourceId,
        entityId: ent.id,
        pointId: point.id,
        action: 'point_created',
      });
      expect(entry.pointId).toBe(point.id);
    });

    it('leaves optional fields null', () => {
      const entry = repo.create({
        sourceId: defaultSourceId,
        action: 'source_confirmed_empty',
      });
      expect(entry.entityId).toBeNull();
      expect(entry.pointId).toBeNull();
      expect(entry.summary).toBeNull();
    });
  });

  describe('getBySourceId', () => {
    it('returns events for a source', () => {
      repo.create({ sourceId: defaultSourceId, action: 'source_confirmed' });
      repo.create({ sourceId: defaultSourceId, action: 'entity_created' });
      const src2 = srcRepo.create({ kind: 'user', rawContent: 'other' });
      repo.create({ sourceId: src2.id, action: 'source_confirmed' });
      const logs = repo.getBySourceId(defaultSourceId);
      expect(logs).toHaveLength(2);
    });
  });

  describe('getByAction', () => {
    it('filters by action type', () => {
      repo.create({ sourceId: defaultSourceId, action: 'source_confirmed' });
      repo.create({ sourceId: defaultSourceId, action: 'entity_created' });
      repo.create({ sourceId: defaultSourceId, action: 'source_confirmed' });
      const logs = repo.getByAction('source_confirmed');
      expect(logs).toHaveLength(2);
    });
  });

  describe('getRecent', () => {
    it('returns most recent events', () => {
      for (let i = 0; i < 10; i++) {
        repo.create({ sourceId: defaultSourceId, action: 'point_created' });
      }
      const recent = repo.getRecent(5);
      expect(recent).toHaveLength(5);
      expect(recent[0].id).toBeGreaterThan(recent[4].id);
    });
  });
});

describe('SubmissionLogRepository', () => {
  let t: TestDB;
  let repo: SqliteSubmissionLogRepository;

  beforeEach(() => {
    t = createTestDB();
    repo = new SqliteSubmissionLogRepository(t.db);
  });

  afterEach(() => {
    t.cleanup();
  });

  describe('create', () => {
    it('writes accepted submission with required taskId and sourceId', () => {
      const [src] = t.db
        .insert(schema.sources)
        .values({
          kind: 'external',
          normalizedUrl: 'https://example.com/article',
          originalUrl: 'https://example.com/article',
        })
        .returning()
        .all();
      const [task] = t.db
        .insert(schema.processingTasks)
        .values({
          sourceId: src.id,
          type: 'pipeline',
        })
        .returning()
        .all();

      const entry = repo.create({
        rawInput: 'https://example.com/article',
        result: 'accepted',
        taskId: task.id,
        sourceId: src.id,
      });
      expect(entry.id).toBeGreaterThan(0);
      expect(entry.result).toBe('accepted');
      expect(entry.reason).toBeNull();
      expect(entry.taskId).toBe(task.id);
      expect(entry.sourceId).toBe(src.id);
    });

    it('writes duplicate submission with reason', () => {
      const entry = repo.create({
        rawInput: 'https://example.com/article',
        result: 'duplicate',
        reason: 'URL already processing (source #5)',
      });
      expect(entry.result).toBe('duplicate');
      expect(entry.reason).toBe('URL already processing (source #5)');
    });

    it('writes rejected submission with reason', () => {
      const entry = repo.create({
        rawInput: '',
        result: 'rejected',
        reason: 'Empty input',
      });
      expect(entry.result).toBe('rejected');
    });

    it('rejects accepted submission without sourceId/taskId (runtime guard)', () => {
      expect(() => {
        repo.create({
          rawInput: 'https://example.com',
          result: 'accepted',
        } as any);
      }).toThrow(/accepted submission requires both sourceId and taskId/);
    });
  });

  describe('getRecent', () => {
    it('returns most recent submissions', () => {
      for (let i = 0; i < 5; i++) {
        repo.create({
          rawInput: `input-${i}`,
          result: 'rejected',
          reason: `Reason ${i}`,
        });
      }
      const recent = repo.getRecent(3);
      expect(recent).toHaveLength(3);
      expect(recent[0].id).toBeGreaterThan(recent[2].id);
    });
  });
});
