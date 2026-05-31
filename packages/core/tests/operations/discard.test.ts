import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteKnowledgeRepository } from '../../src/db/repositories/knowledge.repository';
import { SqliteEventLogRepository } from '../../src/db/repositories/log.repository';
import { SqliteSourceRepository } from '../../src/db/repositories/source.repository';
import { discardSource } from '../../src/operations/discard';
import { createTestDB, type TestDB } from '../helpers/test-db';

describe('discardSource', () => {
  let testDB: TestDB;
  let sourceRepo: InstanceType<typeof SqliteSourceRepository>;
  let knowledgeRepo: InstanceType<typeof SqliteKnowledgeRepository>;
  let eventLogRepo: InstanceType<typeof SqliteEventLogRepository>;

  beforeEach(() => {
    testDB = createTestDB();
    sourceRepo = new SqliteSourceRepository(testDB.db);
    knowledgeRepo = new SqliteKnowledgeRepository(testDB.db);
    eventLogRepo = new SqliteEventLogRepository(testDB.db);
  });

  afterEach(() => {
    testDB.cleanup();
  });

  function makeDeps(embeddingEnabled = false) {
    return {
      db: testDB.db,
      repos: { knowledge: knowledgeRepo, eventLog: eventLogRepo },
      embeddingEnabled,
    };
  }

  // ─── helper: create a source and move it to the given status ───
  function createSourceWithStatus(status: 'confirmed' | 'confirmed_empty' | 'processing') {
    const source = sourceRepo.create({
      kind: 'external',
      originalUrl: 'https://example.com/article',
      normalizedUrl: 'example.com/article',
    });
    if (status !== 'processing') {
      sourceRepo.updateStatus(source.id, status);
    }
    return source;
  }

  // ─── helper: create a full knowledge chain (source → entity → point → SEP) ───
  function createKnowledgeChain(sourceId: number) {
    const entity = knowledgeRepo.createEntity({ name: 'Test Entity' });
    const point = knowledgeRepo.createPoint('Some fact content', 'fact');
    knowledgeRepo.createSourceEntityPoint(sourceId, entity.id, point.id, 'new');
    return { entity, point };
  }

  // ─── invalid status scenarios ─────────────────────────────────

  it('returns invalid_status for non-existent source', () => {
    const result = discardSource(999, makeDeps());
    expect(result).toEqual({ ok: false, code: 'invalid_status' });
  });

  it('returns invalid_status for source in processing status', () => {
    const source = createSourceWithStatus('processing');
    const result = discardSource(source.id, makeDeps());
    expect(result).toEqual({ ok: false, code: 'invalid_status' });
  });

  // ─── confirmed_empty discard ──────────────────────────────────

  it('discards a confirmed_empty source without knowledge cleanup', () => {
    const source = createSourceWithStatus('confirmed_empty');

    const result = discardSource(source.id, makeDeps());

    expect(result).toEqual({ ok: true });
    const updated = sourceRepo.getById(source.id);
    expect(updated?.status).toBe('discarded');

    // Should have one event log for the confirmed-empty discard
    const logs = eventLogRepo.getBySourceId(source.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('source_discarded');
    expect(logs[0].summary).toContain('Confirmed-empty');
  });

  // ─── confirmed discard with knowledge cleanup ─────────────────

  it('discards a confirmed source and cleans up orphan points', () => {
    const source = createSourceWithStatus('confirmed');
    const { entity, point } = createKnowledgeChain(source.id);

    const result = discardSource(source.id, makeDeps());

    expect(result).toEqual({ ok: true });

    // Source is discarded
    const updated = sourceRepo.getById(source.id);
    expect(updated?.status).toBe('discarded');

    // Orphan point should be discarded
    const updatedPoint = knowledgeRepo.getPointById(point.id);
    expect(updatedPoint?.status).toBe('discarded');

    // Entity should now have no active points
    expect(knowledgeRepo.entityHasActivePoints(entity.id)).toBe(false);

    // Should have event logs: point_discarded + source_discarded summary
    const logs = eventLogRepo.getBySourceId(source.id);
    const pointDiscardLogs = logs.filter((l) => l.action === 'point_discarded');
    const sourceDiscardLogs = logs.filter((l) => l.action === 'source_discarded');
    expect(pointDiscardLogs).toHaveLength(1);
    expect(sourceDiscardLogs).toHaveLength(1);
    expect(sourceDiscardLogs[0].summary).toContain('1 orphan points cleaned');
    expect(sourceDiscardLogs[0].summary).toContain('1 now empty');
  });

  it('does not discard points that are still linked to other sources', () => {
    // Source A: confirmed, will be discarded
    const sourceA = sourceRepo.create({
      kind: 'external',
      originalUrl: 'https://example.com/a',
      normalizedUrl: 'example.com/a',
    });
    sourceRepo.updateStatus(sourceA.id, 'confirmed');

    // Source B: confirmed, keeps the point alive
    const sourceB = sourceRepo.create({
      kind: 'external',
      originalUrl: 'https://example.com/b',
      normalizedUrl: 'example.com/b',
    });
    sourceRepo.updateStatus(sourceB.id, 'confirmed');

    const entity = knowledgeRepo.createEntity({ name: 'Shared Entity' });
    const point = knowledgeRepo.createPoint('Shared fact', 'fact');
    knowledgeRepo.createSourceEntityPoint(sourceA.id, entity.id, point.id, 'new');
    knowledgeRepo.createSourceEntityPoint(sourceB.id, entity.id, point.id, 'new');

    const result = discardSource(sourceA.id, makeDeps());
    expect(result).toEqual({ ok: true });

    // Point should remain active (still linked to sourceB)
    const updatedPoint = knowledgeRepo.getPointById(point.id);
    expect(updatedPoint?.status).toBe('active');

    // Entity should still have active points
    expect(knowledgeRepo.entityHasActivePoints(entity.id)).toBe(true);
  });

  // ─── idempotency: already discarded source returns invalid_status ──

  it('returns invalid_status when source is already discarded', () => {
    const source = createSourceWithStatus('confirmed_empty');
    discardSource(source.id, makeDeps()); // first discard succeeds
    const result = discardSource(source.id, makeDeps()); // second attempt
    expect(result).toEqual({ ok: false, code: 'invalid_status' });
  });

  // ─── post-transaction cleanup is non-fatal ────────────────────

  it('returns ok even if post-transaction cleanup throws', () => {
    const source = createSourceWithStatus('confirmed');
    createKnowledgeChain(source.id);

    // Use a deps with a broken knowledge repo for post-tx cleanup
    const brokenKnowledge = {
      ...knowledgeRepo,
      getEntityIdsForSource: knowledgeRepo.getEntityIdsForSource.bind(knowledgeRepo),
      findOrphanPoints: () => {
        throw new Error('Simulated cleanup failure');
      },
    } as typeof knowledgeRepo;

    const result = discardSource(source.id, {
      db: testDB.db,
      repos: { knowledge: brokenKnowledge, eventLog: eventLogRepo },
      embeddingEnabled: false,
    });

    // Operation still succeeds — source is discarded
    expect(result).toEqual({ ok: true });
    const updated = sourceRepo.getById(source.id);
    expect(updated?.status).toBe('discarded');
  });
});
