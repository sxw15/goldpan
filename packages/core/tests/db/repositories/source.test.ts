import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteCategoryRepository } from '../../../src/db/repositories/category.repository.js';
import { SqliteKnowledgeRepository } from '../../../src/db/repositories/knowledge.repository.js';
import { SqliteSourceRepository } from '../../../src/db/repositories/source.repository.js';
import { sources } from '../../../src/db/schema.js';
import { createTestDB, type TestDB } from '../../helpers/test-db.js';

describe('SourceRepository', () => {
  let t: TestDB;
  let repo: SqliteSourceRepository;

  beforeEach(() => {
    t = createTestDB();
    repo = new SqliteSourceRepository(t.db);
  });

  afterEach(() => {
    t.cleanup();
  });

  describe('create', () => {
    it('creates external source with URLs', () => {
      const src = repo.create({
        kind: 'external',
        normalizedUrl: 'https://example.com/article',
        originalUrl: 'https://www.example.com/article?utm_source=twitter',
      });
      expect(src.id).toBeGreaterThan(0);
      expect(src.kind).toBe('external');
      expect(src.status).toBe('processing');
      expect(src.normalizedUrl).toBe('https://example.com/article');
    });

    it('creates user source without URLs', () => {
      const src = repo.create({
        kind: 'user',
        rawContent: 'Claude Code is amazing',
      });
      expect(src.kind).toBe('user');
      expect(src.normalizedUrl).toBeNull();
    });
  });

  describe('findActiveByNormalizedUrl', () => {
    it('finds processing source', () => {
      repo.create({
        kind: 'external',
        normalizedUrl: 'https://example.com/a',
        originalUrl: 'https://example.com/a',
      });
      const found = repo.findActiveByNormalizedUrl('https://example.com/a');
      expect(found).toBeDefined();
      expect(found?.status).toBe('processing');
    });

    it('finds confirmed source', () => {
      const src = repo.create({
        kind: 'external',
        normalizedUrl: 'https://example.com/a',
        originalUrl: 'https://example.com/a',
      });
      repo.updateStatus(src.id, 'confirmed');
      const found = repo.findActiveByNormalizedUrl('https://example.com/a');
      expect(found).toBeDefined();
    });

    it('does not find failed source', () => {
      const src = repo.create({
        kind: 'external',
        normalizedUrl: 'https://example.com/a',
        originalUrl: 'https://example.com/a',
      });
      repo.updateStatus(src.id, 'failed');
      const found = repo.findActiveByNormalizedUrl('https://example.com/a');
      expect(found).toBeUndefined();
    });

    it('does not find confirmed_empty source', () => {
      const src = repo.create({
        kind: 'external',
        normalizedUrl: 'https://example.com/a',
        originalUrl: 'https://example.com/a',
      });
      repo.updateStatus(src.id, 'confirmed_empty');
      const found = repo.findActiveByNormalizedUrl('https://example.com/a');
      expect(found).toBeUndefined();
    });
  });

  describe('updateStatus', () => {
    it('updates source status', () => {
      const src = repo.create({ kind: 'user', rawContent: 'test' });
      repo.updateStatus(src.id, 'confirmed');
      const updated = repo.getById(src.id);
      expect(updated?.status).toBe('confirmed');
    });
  });

  describe('updateAfterCollecting', () => {
    it('updates title, rawContent, metadata', () => {
      const src = repo.create({
        kind: 'external',
        normalizedUrl: 'https://example.com/a',
        originalUrl: 'https://example.com/a',
      });
      repo.updateAfterCollecting(src.id, {
        title: 'Article Title',
        rawContent: '# Article\n\nContent here',
        collectorMetadata: { collector_author: 'John' },
      });
      const updated = repo.getById(src.id);
      expect(updated?.title).toBe('Article Title');
      expect(updated?.rawContent).toBe('# Article\n\nContent here');
      const meta = JSON.parse(updated!.metadata!);
      expect(meta.collector_author).toBe('John');
    });

    it('preserves existing metadata fields during shallow merge (spec §7.2)', () => {
      const src = repo.create({
        kind: 'external',
        normalizedUrl: 'https://example.com/b',
        originalUrl: 'https://example.com/b',
        metadata: { userAnnotation: 'Very interesting article' },
      });
      repo.updateAfterCollecting(src.id, {
        rawContent: '# Content',
        collectorMetadata: { collector_author: 'John', collector_wordCount: 1500 },
      });
      const updated = repo.getById(src.id);
      const meta = JSON.parse(updated!.metadata!);
      expect(meta.userAnnotation).toBe('Very interesting article');
      expect(meta.collector_author).toBe('John');
      expect(meta.collector_wordCount).toBe(1500);
    });

    it('preserves existing title when collector omits title', () => {
      const src = repo.create({
        kind: 'external',
        normalizedUrl: 'https://example.com/c',
        originalUrl: 'https://example.com/c',
      });
      repo.updateStatus(src.id, 'processing');
      t.db.update(sources).set({ title: 'User Title' }).where(eq(sources.id, src.id)).run();

      repo.updateAfterCollecting(src.id, { rawContent: '# Content' });
      const updated = repo.getById(src.id);
      expect(updated?.title).toBe('User Title');
    });
  });

  describe('updateAfterCollecting — precondition', () => {
    it('rejects collecting for user source', () => {
      const src = repo.create({ kind: 'user', rawContent: 'user text' });
      expect(() => repo.updateAfterCollecting(src.id, { rawContent: 'new' })).toThrow(
        /only external sources/i,
      );
      expect(repo.getById(src.id)?.rawContent).toBe('user text');
    });
  });

  describe('getByStatus', () => {
    it('returns sources filtered by status', () => {
      repo.create({ kind: 'user', rawContent: 'test1' });
      const src2 = repo.create({ kind: 'user', rawContent: 'test2' });
      repo.updateStatus(src2.id, 'confirmed');

      const processing = repo.getByStatus('processing');
      expect(processing).toHaveLength(1);
      expect(processing[0].rawContent).toBe('test1');

      const confirmed = repo.getByStatus('confirmed');
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0].id).toBe(src2.id);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        repo.create({ kind: 'user', rawContent: `test${i}` });
      }
      const limited = repo.getByStatus('processing', 2);
      expect(limited).toHaveLength(2);
    });
  });

  describe('mergeMetadata', () => {
    it('merges new fields into existing metadata JSON', () => {
      const source = repo.create({
        kind: 'external',
        normalizedUrl: 'https://example.test/a',
        originalUrl: 'https://example.test/a',
        metadata: { collectorPlugin: 'collector-github' },
      });
      repo.mergeMetadata(source.id, { collector_failure_code: 'not_found' });
      const fresh = repo.getById(source.id);
      const parsed = JSON.parse(fresh?.metadata ?? '{}');
      expect(parsed.collectorPlugin).toBe('collector-github');
      expect(parsed.collector_failure_code).toBe('not_found');
    });

    it('initialises metadata when row has null metadata', () => {
      const source = repo.create({
        kind: 'external',
        normalizedUrl: 'https://example.test/b',
        originalUrl: 'https://example.test/b',
      });
      expect(source.metadata).toBeNull();
      repo.mergeMetadata(source.id, { collector_failure_code: 'rate_limited' });
      const fresh = repo.getById(source.id);
      const parsed = JSON.parse(fresh?.metadata ?? '{}');
      expect(parsed.collector_failure_code).toBe('rate_limited');
    });

    it('is a no-op when the row does not exist', () => {
      expect(() =>
        repo.mergeMetadata(99999, { collector_failure_code: 'not_found' }),
      ).not.toThrow();
    });
  });

  describe('list', () => {
    it('returns all sources ordered by createdAt desc when no filter', () => {
      const a = repo.create({
        kind: 'external',
        normalizedUrl: 'https://a.example.com',
        originalUrl: 'https://a.example.com',
      });
      // Guarantee distinct createdAt — same-ms inserts otherwise tie on order
      t.db
        .update(sources)
        .set({ createdAt: Date.UTC(2024, 0, 1, 0, 0, 0) })
        .where(eq(sources.id, a.id))
        .run();
      const b = repo.create({
        kind: 'external',
        normalizedUrl: 'https://b.example.com',
        originalUrl: 'https://b.example.com',
      });
      t.db
        .update(sources)
        .set({ createdAt: Date.UTC(2024, 0, 2, 0, 0, 0) })
        .where(eq(sources.id, b.id))
        .run();
      const result = repo.list();
      expect(result.map((r) => r.id)).toEqual([b.id, a.id]);
    });

    it('filters by status', () => {
      const a = repo.create({
        kind: 'external',
        normalizedUrl: 'https://a.example.com',
        originalUrl: 'https://a.example.com',
      });
      repo.updateStatus(a.id, 'confirmed');
      repo.create({
        kind: 'external',
        normalizedUrl: 'https://b.example.com',
        originalUrl: 'https://b.example.com',
      });
      const confirmed = repo.list({ status: 'confirmed' });
      expect(confirmed.map((r) => r.id)).toEqual([a.id]);
    });

    it('filters by origin', () => {
      repo.create({
        kind: 'external',
        normalizedUrl: 'https://u.example.com',
        originalUrl: 'https://u.example.com',
      });
      const trackingSrc = repo.create({
        kind: 'external',
        normalizedUrl: 'https://t.example.com',
        originalUrl: 'https://t.example.com',
      });
      t.db.update(sources).set({ origin: 'tracking' }).where(eq(sources.id, trackingSrc.id)).run();
      const trackingOnly = repo.list({ origin: 'tracking' });
      expect(trackingOnly.map((r) => r.id)).toEqual([trackingSrc.id]);
    });

    it('respects limit (default 100 when not provided; hard caps at 200 enforced by route layer)', () => {
      for (let i = 0; i < 5; i++) {
        repo.create({
          kind: 'external',
          normalizedUrl: `https://n${i}.example.com`,
          originalUrl: `https://n${i}.example.com`,
        });
      }
      expect(repo.list({ limit: 2 })).toHaveLength(2);
    });

    it('does not expose rawContent or metadata fields', () => {
      const s = repo.create({
        kind: 'external',
        normalizedUrl: 'https://x.example.com',
        originalUrl: 'https://x.example.com',
        metadata: { priv: true },
      });
      const [item] = repo.list();
      expect(item.id).toBe(s.id);
      expect((item as unknown as Record<string, unknown>).rawContent).toBeUndefined();
      expect((item as unknown as Record<string, unknown>).metadata).toBeUndefined();
    });

    it('SourceListItem returned key-set matches the SDK fixture (drift sentinel)', () => {
      // Locked manually instead of importing SOURCE_LIST_ITEM_KEYS from the
      // SDK fixture to avoid core→web-sdk dep direction reversal. If this list
      // drifts from packages/web-sdk/tests/fixtures/sources.fixture.ts, both
      // tests fail in concert and the contract violation is unmissable.
      const expectedKeys = [
        'createdAt',
        'entityCategoryPaths',
        'entityCount',
        'id',
        'kind',
        'kpCount',
        'normalizedUrl',
        'originalUrl',
        'origin',
        'preview',
        'status',
        'title',
        'topEntities',
      ].sort();
      repo.create({
        kind: 'external',
        normalizedUrl: 'https://drift.example.com',
        originalUrl: 'https://drift.example.com',
      });
      const [item] = repo.list();
      expect(Object.keys(item).sort()).toEqual(expectedKeys);
    });

    it('combines origin filter with multi-value status filter via AND', () => {
      const userConfirmed = repo.create({
        kind: 'external',
        normalizedUrl: 'https://uc.example.com',
        originalUrl: 'https://uc.example.com',
      });
      repo.updateStatus(userConfirmed.id, 'confirmed');
      const trackingConfirmed = repo.create({
        kind: 'external',
        normalizedUrl: 'https://tc.example.com',
        originalUrl: 'https://tc.example.com',
      });
      t.db
        .update(sources)
        .set({ origin: 'tracking' })
        .where(eq(sources.id, trackingConfirmed.id))
        .run();
      repo.updateStatus(trackingConfirmed.id, 'confirmed');
      const userDiscarded = repo.create({
        kind: 'external',
        normalizedUrl: 'https://ud.example.com',
        originalUrl: 'https://ud.example.com',
      });
      repo.updateStatus(userDiscarded.id, 'discarded');

      const items = repo.list({ origin: 'user', status: ['confirmed', 'discarded'] });
      const ids = items.map((i) => i.id).sort();
      expect(ids).toEqual([userConfirmed.id, userDiscarded.id].sort());
    });

    it('returns kpCount and entityCount aggregated over source_entity_points', () => {
      const knowledgeRepo = new SqliteKnowledgeRepository(t.db);
      const src = repo.create({
        kind: 'external',
        normalizedUrl: 'https://kp.example.com',
        originalUrl: 'https://kp.example.com',
      });
      repo.updateStatus(src.id, 'confirmed');
      const eA = knowledgeRepo.createEntity({ name: 'EntA' });
      const eB = knowledgeRepo.createEntity({ name: 'EntB' });
      const p1 = knowledgeRepo.createPoint('p1', 'fact');
      const p2 = knowledgeRepo.createPoint('p2', 'fact');
      const p3 = knowledgeRepo.createPoint('p3', 'fact');
      knowledgeRepo.createSourceEntityPoint(src.id, eA.id, p1.id, 'new');
      knowledgeRepo.createSourceEntityPoint(src.id, eA.id, p2.id, 'new');
      knowledgeRepo.createSourceEntityPoint(src.id, eB.id, p3.id, 'new');
      const [item] = repo.list({ status: 'confirmed' });
      expect(item.kpCount).toBe(3);
      expect(item.entityCount).toBe(2);
    });

    it('counts skipped sep rows toward kpCount / entityCount (库 视角，spec §4.4)', () => {
      const knowledgeRepo = new SqliteKnowledgeRepository(t.db);
      const src = repo.create({
        kind: 'external',
        normalizedUrl: 'https://skip.example.com',
        originalUrl: 'https://skip.example.com',
      });
      repo.updateStatus(src.id, 'confirmed');
      const ent = knowledgeRepo.createEntity({ name: 'Acme' });
      const p1 = knowledgeRepo.createPoint('shared p1', 'fact');
      const p2 = knowledgeRepo.createPoint('shared p2', 'fact');
      knowledgeRepo.createSourceEntityPoint(src.id, ent.id, p1.id, 'skipped');
      knowledgeRepo.createSourceEntityPoint(src.id, ent.id, p2.id, 'skipped');
      const [item] = repo.list({ status: 'confirmed' });
      expect(item.kpCount).toBe(2);
      expect(item.entityCount).toBe(1);
    });

    it('preview is rawContent first 80 chars for kind=user, null for kind=external', () => {
      const long = 'x'.repeat(200);
      const userSrc = repo.create({ kind: 'user', rawContent: long });
      repo.updateStatus(userSrc.id, 'confirmed');
      const externalSrc = repo.create({
        kind: 'external',
        normalizedUrl: 'https://ext.example.com',
        originalUrl: 'https://ext.example.com',
      });
      repo.updateStatus(externalSrc.id, 'confirmed');
      const items = repo.list({ status: 'confirmed' });
      const u = items.find((i) => i.id === userSrc.id);
      const e = items.find((i) => i.id === externalSrc.id);
      expect(u?.preview).toBe('x'.repeat(80));
      expect(e?.preview).toBeNull();
    });

    it('confirmed_empty source has kpCount=0, entityCount=0, preview=null when external', () => {
      const src = repo.create({
        kind: 'external',
        normalizedUrl: 'https://empty.example.com',
        originalUrl: 'https://empty.example.com',
      });
      repo.updateStatus(src.id, 'confirmed_empty');
      const items = repo.list({ status: 'confirmed_empty' });
      const item = items.find((i) => i.id === src.id);
      expect(item?.kpCount).toBe(0);
      expect(item?.entityCount).toBe(0);
      expect(item?.preview).toBeNull();
      expect(item?.topEntities).toEqual([]);
      expect(item?.entityCategoryPaths).toEqual([]);
    });

    it('returns topEntities sorted by per-entity kpCount DESC, capped at 3', () => {
      const knowledgeRepo = new SqliteKnowledgeRepository(t.db);
      const src = repo.create({
        kind: 'external',
        normalizedUrl: 'https://top.example.com',
        originalUrl: 'https://top.example.com',
      });
      repo.updateStatus(src.id, 'confirmed');
      const ents = ['E1', 'E2', 'E3', 'E4'].map((n) => knowledgeRepo.createEntity({ name: n }));
      const counts = [1, 4, 2, 3]; // E1=1 KP, E2=4 KP, E3=2 KP, E4=3 KP
      for (let i = 0; i < ents.length; i++) {
        for (let k = 0; k < counts[i]; k++) {
          const p = knowledgeRepo.createPoint(`${ents[i].name}-p${k}`, 'fact');
          knowledgeRepo.createSourceEntityPoint(src.id, ents[i].id, p.id, 'new');
        }
      }
      const [item] = repo.list({ status: 'confirmed' });
      expect(item.topEntities.map((e) => e.name)).toEqual(['E2', 'E4', 'E3']);
      expect(item.entityCount).toBe(4);
    });

    it('throws on empty status array (ambiguous: pass undefined for "all")', () => {
      expect(() => repo.list({ status: [] })).toThrow(/empty array/i);
    });

    it('kpCount uses DISTINCT pointId — same point linked via multiple entities counts once', () => {
      const knowledgeRepo = new SqliteKnowledgeRepository(t.db);
      const src = repo.create({
        kind: 'external',
        normalizedUrl: 'https://distinct.example.com',
        originalUrl: 'https://distinct.example.com',
      });
      repo.updateStatus(src.id, 'confirmed');
      const eA = knowledgeRepo.createEntity({ name: 'A' });
      const eB = knowledgeRepo.createEntity({ name: 'B' });
      const shared = knowledgeRepo.createPoint('shared point', 'fact');
      knowledgeRepo.createSourceEntityPoint(src.id, eA.id, shared.id, 'new');
      knowledgeRepo.createSourceEntityPoint(src.id, eB.id, shared.id, 'new');
      const [item] = repo.list({ status: 'confirmed' });
      expect(item.kpCount).toBe(1);
      expect(item.entityCount).toBe(2);
    });

    it('topEntities tie-break by entityId ASC when per-entity kpCount is equal', () => {
      const knowledgeRepo = new SqliteKnowledgeRepository(t.db);
      const src = repo.create({
        kind: 'external',
        normalizedUrl: 'https://tie.example.com',
        originalUrl: 'https://tie.example.com',
      });
      repo.updateStatus(src.id, 'confirmed');
      const ents = ['Z', 'Y', 'X', 'W'].map((n) => knowledgeRepo.createEntity({ name: n }));
      for (const ent of ents) {
        const p = knowledgeRepo.createPoint(`p-${ent.id}`, 'fact');
        knowledgeRepo.createSourceEntityPoint(src.id, ent.id, p.id, 'new');
      }
      const [item] = repo.list({ status: 'confirmed' });
      // All 4 tied at kpCount=1; tie-break by entityId ASC keeps the first 3 created.
      expect(item.topEntities.map((e) => e.id)).toEqual([ents[0].id, ents[1].id, ents[2].id]);
    });

    it('returns entityCategoryPaths distinct across multi-entity multi-category', () => {
      const knowledgeRepo = new SqliteKnowledgeRepository(t.db);
      const categoryRepo = new SqliteCategoryRepository(t.db);
      const src = repo.create({
        kind: 'external',
        normalizedUrl: 'https://cats.example.com',
        originalUrl: 'https://cats.example.com',
      });
      repo.updateStatus(src.id, 'confirmed');
      const eA = knowledgeRepo.createEntity({ name: 'Foo' });
      const eB = knowledgeRepo.createEntity({ name: 'Bar' });
      const cTech = categoryRepo.ensureCategoryPath('/Tech/AI');
      const cBiz = categoryRepo.ensureCategoryPath('/Business');
      knowledgeRepo.linkEntityToCategory(eA.id, cTech);
      knowledgeRepo.linkEntityToCategory(eA.id, cBiz);
      knowledgeRepo.linkEntityToCategory(eB.id, cTech);
      const p1 = knowledgeRepo.createPoint('p1', 'fact');
      const p2 = knowledgeRepo.createPoint('p2', 'fact');
      knowledgeRepo.createSourceEntityPoint(src.id, eA.id, p1.id, 'new');
      knowledgeRepo.createSourceEntityPoint(src.id, eB.id, p2.id, 'new');
      const [item] = repo.list({ status: 'confirmed' });
      expect([...item.entityCategoryPaths].sort()).toEqual(['/Business', '/Tech/AI']);
    });
  });

  describe('getStatusCounts', () => {
    it('returns zero-filled counts for all 5 statuses', () => {
      const counts = repo.getStatusCounts();
      expect(counts).toEqual({
        processing: 0,
        confirmed: 0,
        confirmed_empty: 0,
        failed: 0,
        discarded: 0,
      });
    });

    it('returns counts independent of any filter', () => {
      const a = repo.create({ kind: 'user', rawContent: 'a' });
      const b = repo.create({ kind: 'user', rawContent: 'b' });
      const c = repo.create({ kind: 'user', rawContent: 'c' });
      repo.create({ kind: 'user', rawContent: 'd' });
      repo.updateStatus(a.id, 'confirmed');
      repo.updateStatus(b.id, 'confirmed');
      repo.updateStatus(c.id, 'failed');
      const counts = repo.getStatusCounts();
      expect(counts.processing).toBe(1);
      expect(counts.confirmed).toBe(2);
      expect(counts.failed).toBe(1);
      expect(counts.confirmed_empty).toBe(0);
      expect(counts.discarded).toBe(0);
    });
  });

  describe('getDetailWithEntities', () => {
    let knowledgeRepo: SqliteKnowledgeRepository;
    let categoryRepo: SqliteCategoryRepository;

    beforeEach(() => {
      knowledgeRepo = new SqliteKnowledgeRepository(t.db);
      categoryRepo = new SqliteCategoryRepository(t.db);
    });

    it('returns null when source not found', () => {
      expect(repo.getDetailWithEntities(9999)).toBeNull();
    });

    it('returns source + empty entities when no associations exist', () => {
      const src = repo.create({
        kind: 'external',
        normalizedUrl: 'https://lonely.example.com',
        originalUrl: 'https://lonely.example.com',
      });
      const result = repo.getDetailWithEntities(src.id);
      expect(result).not.toBeNull();
      expect(result?.source.id).toBe(src.id);
      expect(result?.entities).toEqual([]);
      expect(result?.entityCount).toBe(0);
    });

    it('returns source + associated entities with deduped categoryPaths', () => {
      const src = repo.create({
        kind: 'external',
        normalizedUrl: 'https://joined.example.com',
        originalUrl: 'https://joined.example.com',
      });
      const entity = knowledgeRepo.createEntity({ name: 'Acme Corp' });
      const catTechId = categoryRepo.ensureCategoryPath('/Tech/AI');
      const catBizId = categoryRepo.ensureCategoryPath('/Business/Enterprise');
      knowledgeRepo.linkEntityToCategory(entity.id, catTechId);
      knowledgeRepo.linkEntityToCategory(entity.id, catBizId);
      const point = knowledgeRepo.createPoint('Acme was founded in 2010', 'fact');
      knowledgeRepo.createSourceEntityPoint(src.id, entity.id, point.id, 'new');

      const result = repo.getDetailWithEntities(src.id);
      expect(result).not.toBeNull();
      expect(result?.source.id).toBe(src.id);
      expect(result?.entities).toHaveLength(1);
      expect(result?.entities[0].id).toBe(entity.id);
      expect(result?.entities[0].name).toBe('Acme Corp');
      expect(result?.entities[0].categoryPaths.sort()).toEqual([
        '/Business/Enterprise',
        '/Tech/AI',
      ]);
      expect(result?.entityCount).toBe(1);
    });

    it('dedupes entities (same entityId linked via multiple points counts once)', () => {
      const src = repo.create({
        kind: 'external',
        normalizedUrl: 'https://dup.example.com',
        originalUrl: 'https://dup.example.com',
      });
      const entity = knowledgeRepo.createEntity({ name: 'Beta LLC' });
      const p1 = knowledgeRepo.createPoint('fact 1', 'fact');
      const p2 = knowledgeRepo.createPoint('fact 2', 'fact');
      knowledgeRepo.createSourceEntityPoint(src.id, entity.id, p1.id, 'new');
      knowledgeRepo.createSourceEntityPoint(src.id, entity.id, p2.id, 'new');

      const result = repo.getDetailWithEntities(src.id);
      expect(result?.entities).toHaveLength(1);
      expect(result?.entities[0].id).toBe(entity.id);
      expect(result?.entityCount).toBe(1);
    });
  });

  describe('updateStatus onTerminated callback (P0.3)', () => {
    it('fires onTerminated for every terminal status', () => {
      const calls: Array<{ id: number; status: string }> = [];
      const repoWithDeps = new SqliteSourceRepository(t.db, {
        onSourceTerminated: (id, status) => {
          calls.push({ id, status });
        },
      });

      const mkSrc = () =>
        repoWithDeps.create({
          kind: 'user',
          rawContent: 'cb-test',
        });

      const s1 = mkSrc();
      repoWithDeps.updateStatus(s1.id, 'confirmed');
      const s2 = mkSrc();
      repoWithDeps.updateStatus(s2.id, 'confirmed_empty');
      const s3 = mkSrc();
      repoWithDeps.updateStatus(s3.id, 'failed');
      const s4 = mkSrc();
      repoWithDeps.updateStatus(s4.id, 'discarded');

      expect(calls).toEqual([
        { id: s1.id, status: 'confirmed' },
        { id: s2.id, status: 'confirmed_empty' },
        { id: s3.id, status: 'failed' },
        { id: s4.id, status: 'discarded' },
      ]);
    });

    it('does not fire onTerminated for non-terminal processing', () => {
      const calls: Array<{ id: number; status: string }> = [];
      const repoWithDeps = new SqliteSourceRepository(t.db, {
        onSourceTerminated: (id, status) => {
          calls.push({ id, status });
        },
      });

      const src = repoWithDeps.create({ kind: 'user', rawContent: 'no-cb' });
      repoWithDeps.updateStatus(src.id, 'processing');

      expect(calls).toEqual([]);
    });

    it('can defer onTerminated emission until the caller explicitly emits', () => {
      const calls: Array<{ id: number; status: string }> = [];
      const repoWithDeps = new SqliteSourceRepository(t.db, {
        onSourceTerminated: (id, status) => {
          calls.push({ id, status });
        },
      });

      const src = repoWithDeps.create({ kind: 'user', rawContent: 'defer-cb' });
      repoWithDeps.updateStatus(src.id, 'confirmed', { emitTerminated: false });

      expect(calls).toEqual([]);
      repoWithDeps.emitTerminated(src.id, 'confirmed');
      expect(calls).toEqual([{ id: src.id, status: 'confirmed' }]);
    });

    it('works without deps (backward compat)', () => {
      const src = repo.create({ kind: 'user', rawContent: 'no-deps' });
      expect(() => repo.updateStatus(src.id, 'confirmed')).not.toThrow();
    });
  });
});
