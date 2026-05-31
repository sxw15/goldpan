import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRawDatabase } from '../../../src/db/connection.js';
import { SqliteCategoryRepository } from '../../../src/db/repositories/category.repository.js';
import { SqliteKnowledgeRepository } from '../../../src/db/repositories/knowledge.repository.js';
import { SqliteSourceRepository } from '../../../src/db/repositories/source.repository.js';
import { tags } from '../../../src/db/schema.js';
import { createTestDB, type TestDB } from '../../helpers/test-db.js';

describe('KnowledgeRepository', () => {
  let t: TestDB;
  let repo: SqliteKnowledgeRepository;
  let catRepo: SqliteCategoryRepository;
  let srcRepo: SqliteSourceRepository;

  beforeEach(() => {
    t = createTestDB();
    repo = new SqliteKnowledgeRepository(t.db);
    catRepo = new SqliteCategoryRepository(t.db);
    srcRepo = new SqliteSourceRepository(t.db);
  });

  afterEach(() => {
    t.cleanup();
  });

  describe('Entity CRUD', () => {
    it('creates entity with defaults', () => {
      const ent = repo.createEntity({ name: 'Claude Code' });
      expect(ent.id).toBeGreaterThan(0);
      expect(ent.aliases).toBe('[]');
      expect(ent.keywords).toBe('[]');
    });

    it('creates entity with aliases and keywords', () => {
      const ent = repo.createEntity({
        name: 'Claude Code',
        description: 'AI CLI tool',
        aliases: ['claude-code', 'Anthropic CLI'],
        keywords: ['CLI', 'Anthropic', 'Coding Tools'],
      });
      expect(JSON.parse(ent.aliases)).toEqual(['claude-code', 'Anthropic CLI']);
      expect(JSON.parse(ent.keywords)).toEqual(['CLI', 'Anthropic', 'Coding Tools']);
      expect(ent.description).toBe('AI CLI tool');
    });

    it('appends aliases with deduplication', () => {
      const ent = repo.createEntity({
        name: 'Claude Code',
        aliases: ['cc'],
      });
      repo.appendAliases(ent.id, ['cc', 'claude-code', 'new-alias']);
      const updated = repo.getEntityById(ent.id)!;
      const aliases = JSON.parse(updated.aliases);
      expect(aliases).toEqual(['cc', 'claude-code', 'new-alias']);
    });

    it('skips aliases already owned by another entity (cross-entity dedup)', () => {
      const _entA = repo.createEntity({ name: 'Entity A', aliases: ['alias-x'] });
      const entB = repo.createEntity({ name: 'Entity B', aliases: ['alias-y'] });

      repo.appendAliases(entB.id, ['alias-x', 'new-for-b']);
      const updated = repo.getEntityById(entB.id)!;
      const aliases = JSON.parse(updated.aliases);
      expect(aliases).toEqual(['alias-y', 'new-for-b']);
    });
  });

  describe('Entity Registry', () => {
    it('returns entities with active points and category paths', () => {
      const catId = catRepo.ensureCategoryPath('Tech/AI/Tools');
      const ent = repo.createEntity({ name: 'Claude Code' });
      repo.linkEntityToCategory(ent.id, catId);

      const src = srcRepo.create({ kind: 'user', rawContent: 'test' });
      const point = repo.createPoint('Claude Code supports MCP', 'fact');
      repo.createSourceEntityPoint(src.id, ent.id, point.id, 'new');

      const registry = repo.getEntityRegistry();
      expect(registry).toHaveLength(1);
      expect(registry[0].name).toBe('Claude Code');
      expect(registry[0].categoryPaths).toEqual(['/Tech/AI/Tools']);
    });

    it('excludes entities with no active points', () => {
      const _ent = repo.createEntity({ name: 'Empty Entity' });
      const registry = repo.getEntityRegistry();
      expect(registry).toHaveLength(0);
    });
  });

  describe('Knowledge Points', () => {
    it('creates fact point', () => {
      const point = repo.createPoint('TypeScript is statically typed', 'fact');
      expect(point.type).toBe('fact');
      expect(point.status).toBe('active');
    });

    it('creates opinion point', () => {
      const point = repo.createPoint('AI will replace developers', 'opinion');
      expect(point.type).toBe('opinion');
    });
  });

  describe('Tags', () => {
    it('upsertTags returns ids and is idempotent across calls', () => {
      const first = repo.upsertTags(['趋势判断', '短期']);
      expect(first).toHaveLength(2);
      expect(new Set(first.map((t) => t.name))).toEqual(new Set(['趋势判断', '短期']));

      const again = repo.upsertTags(['趋势判断', '短期']);
      expect(again.map((t) => t.id).sort()).toEqual(first.map((t) => t.id).sort());
    });

    it('upsertTags collapses case + whitespace duplicates within a single call', () => {
      const out = repo.upsertTags(['React', '  react ', 'REACT']);
      expect(out).toHaveLength(1);
      expect(out[0].name).toBe('React');
    });

    it('upsertTags collapses case-only duplicates across calls (regression #1)', () => {
      // Two submissions in a row: one writes "React", the next "react".
      // The expected behaviour is that the tag is deduped — DB ends up with
      // exactly one row, and the second call returns that same id.
      const first = repo.upsertTags(['React']);
      const second = repo.upsertTags(['react']);
      expect(second).toHaveLength(1);
      expect(second[0].id).toBe(first[0].id);

      const all = t.db.select().from(tags).all();
      expect(all).toHaveLength(1);
    });

    it('linkPointTags is idempotent and survives repeated submissions', () => {
      const point = repo.createPoint('opinion content', 'opinion');
      const [t1, t2] = repo.upsertTags(['一', '二']);
      repo.linkPointTags(point.id, [t1.id, t2.id]);
      // Repeat link should not throw or create duplicates.
      repo.linkPointTags(point.id, [t1.id, t2.id]);

      const fetched = repo.getTagsForPoints([point.id]);
      expect(fetched.get(point.id)?.sort()).toEqual(['一', '二']);
    });

    it('getTagsForPoints returns empty for empty input without SQL hit', () => {
      expect(repo.getTagsForPoints([])).toEqual(new Map());
    });
  });

  describe('Source-Entity-Point associations', () => {
    it('creates triple association', () => {
      const src = srcRepo.create({ kind: 'user', rawContent: 'test' });
      const ent = repo.createEntity({ name: 'Test' });
      const point = repo.createPoint('fact content', 'fact');

      repo.createSourceEntityPoint(src.id, ent.id, point.id, 'new');

      const points = repo.getActiveFactPointsForEntity(ent.id);
      expect(points).toHaveLength(1);
      expect(points[0].content).toBe('fact content');
    });

    it('supports cross-entity point sharing', () => {
      const src = srcRepo.create({ kind: 'user', rawContent: 'test' });
      const entA = repo.createEntity({ name: 'Entity A' });
      const entB = repo.createEntity({ name: 'Entity B' });
      const point = repo.createPoint('shared fact', 'fact');

      repo.createSourceEntityPoint(src.id, entA.id, point.id, 'new');
      repo.createSourceEntityPoint(src.id, entB.id, point.id, 'skipped');

      expect(repo.getActiveFactPointsForEntity(entA.id)).toHaveLength(1);
      expect(repo.getActiveFactPointsForEntity(entB.id)).toHaveLength(1);
    });

    it('is idempotent', () => {
      const src = srcRepo.create({ kind: 'user', rawContent: 'test' });
      const ent = repo.createEntity({ name: 'Test' });
      const point = repo.createPoint('fact', 'fact');

      repo.createSourceEntityPoint(src.id, ent.id, point.id, 'new');
      repo.createSourceEntityPoint(src.id, ent.id, point.id, 'new');

      const points = repo.getActiveFactPointsForEntity(ent.id);
      expect(points).toHaveLength(1);
    });

    it('getActiveFactPointsForEntity deduplicates by point_id', () => {
      const src1 = srcRepo.create({ kind: 'user', rawContent: 'test1' });
      const src2 = srcRepo.create({ kind: 'user', rawContent: 'test2' });
      const ent = repo.createEntity({ name: 'Test' });
      const point = repo.createPoint('shared fact', 'fact');

      repo.createSourceEntityPoint(src1.id, ent.id, point.id, 'new');
      repo.createSourceEntityPoint(src2.id, ent.id, point.id, 'skipped');

      const points = repo.getActiveFactPointsForEntity(ent.id);
      expect(points).toHaveLength(1);
    });
  });

  describe('Orphan detection', () => {
    it('finds orphan points', () => {
      const point = repo.createPoint('orphan fact', 'fact');
      const orphans = repo.findOrphanPoints();
      expect(orphans).toHaveLength(1);
      expect(orphans[0].id).toBe(point.id);
    });
  });

  describe('linkEntityToCategory', () => {
    it('is idempotent', () => {
      const catId = catRepo.ensureCategoryPath('Tech');
      const ent = repo.createEntity({ name: 'Test' });
      repo.linkEntityToCategory(ent.id, catId);
      repo.linkEntityToCategory(ent.id, catId);
    });
  });

  describe('getEntitiesByIds', () => {
    it('returns entities matching the supplied IDs in arbitrary order', () => {
      const a = repo.createEntity({ name: 'Alpha' });
      const b = repo.createEntity({ name: 'Beta' });
      const c = repo.createEntity({ name: 'Gamma' });
      const result = repo.getEntitiesByIds([c.id, a.id, b.id]);
      expect(result.map((r) => r.name).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
    });

    it('returns empty array for empty input (no SQL hit)', () => {
      expect(repo.getEntitiesByIds([])).toEqual([]);
    });

    it('silently skips IDs that do not exist', () => {
      const a = repo.createEntity({ name: 'Alpha' });
      const result = repo.getEntitiesByIds([a.id, 999_999]);
      expect(result.map((r) => r.id)).toEqual([a.id]);
    });
  });

  describe('findRecentRelations', () => {
    function insertRelation(
      raw: ReturnType<typeof getRawDatabase>,
      sourceEntityId: number,
      targetEntityId: number,
      createdAtMs: number,
    ): number {
      const result = raw
        .prepare(
          `INSERT INTO entity_relations (source_entity_id, target_entity_id, relation_type, description, created_at, updated_at)
           VALUES (?, ?, 'general', 'test relation', ?, ?)`,
        )
        .run(sourceEntityId, targetEntityId, createdAtMs, createdAtMs);
      return result.lastInsertRowid as number;
    }

    it('returns rows newer than sinceMs ordered by created_at desc with category paths', () => {
      const raw = getRawDatabase(t.db);
      const catId = catRepo.ensureCategoryPath('ai/llm');
      const e1 = repo.createEntity({ name: 'Entity1' });
      const e2 = repo.createEntity({ name: 'Entity2' });
      repo.linkEntityToCategory(e1.id, catId);
      repo.linkEntityToCategory(e2.id, catId);

      const now = Date.now();
      insertRelation(raw, e1.id, e2.id, now - 5_000);
      insertRelation(raw, e2.id, e1.id, now - 1_000);

      const out = repo.findRecentRelations({ sinceMs: now - 10_000, limit: 5 });

      expect(out).toHaveLength(2);
      // newest first
      expect(out[0].createdAt).toBeGreaterThan(out[1].createdAt);
      expect(out[0].source.name).toBe('Entity2');
      expect(out[0].target.name).toBe('Entity1');
      expect(out[1].source.name).toBe('Entity1');
      expect(out[1].target.name).toBe('Entity2');
      expect(out[0].source.categoryPaths).toContain('/ai/llm');
      expect(out[0].target.categoryPaths).toContain('/ai/llm');
    });

    it('respects limit', () => {
      const raw = getRawDatabase(t.db);
      // Create 8 entities so we have 7 distinct (source->target) pairs
      const anchor = repo.createEntity({ name: 'LimAnchor' });
      const targets = Array.from({ length: 7 }, (_, i) =>
        repo.createEntity({ name: `LimTarget${i}` }),
      );
      const now = Date.now();
      for (let i = 0; i < targets.length; i++) {
        insertRelation(raw, anchor.id, targets[i].id, now - (7 - i) * 1_000);
      }

      const out = repo.findRecentRelations({ sinceMs: now - 20_000, limit: 3 });
      expect(out).toHaveLength(3);
    });

    it('filters out rows older than sinceMs', () => {
      const raw = getRawDatabase(t.db);
      const e1 = repo.createEntity({ name: 'FilterA' });
      const e2 = repo.createEntity({ name: 'FilterB' });
      const e3 = repo.createEntity({ name: 'FilterC' });
      const now = Date.now();

      insertRelation(raw, e1.id, e2.id, now - 100_000); // old: 100s ago
      insertRelation(raw, e1.id, e3.id, now - 1_000); // new: 1s ago

      const out = repo.findRecentRelations({ sinceMs: now - 50_000, limit: 10 });
      expect(out).toHaveLength(1);
      expect(out[0].source.name).toBe('FilterA');
      expect(out[0].target.name).toBe('FilterC');
    });

    it('returns ms epoch for createdAt (not raw text)', () => {
      const raw = getRawDatabase(t.db);
      const e1 = repo.createEntity({ name: 'TsA' });
      const e2 = repo.createEntity({ name: 'TsB' });
      const now = Date.now();
      const insertedMs = now - 2_000;

      insertRelation(raw, e1.id, e2.id, insertedMs);

      const out = repo.findRecentRelations({ sinceMs: now - 10_000, limit: 5 });
      expect(out).toHaveLength(1);
      expect(typeof out[0].createdAt).toBe('number');
      expect(Number.isFinite(out[0].createdAt)).toBe(true);
      // createdAt should be within 2 seconds of insertion time (datetime precision is 1s)
      expect(Math.abs(out[0].createdAt - insertedMs)).toBeLessThan(2_000);
    });

    it('breaks ties by id DESC when multiple relations share the same created_at ms', () => {
      // 时间列毫秒精度:同毫秒插入多条会产生相同 created_at,CTE 内
      // ORDER BY (created_at, id) DESC 给同毫秒一个稳定 tiebreaker,否则 LIMIT N
      // 在同毫秒 M (M>N) 条里随机丢条 → 分页/截断抖动。
      const raw = getRawDatabase(t.db);
      const anchor = repo.createEntity({ name: 'TieAnchor' });
      const now = Date.now();
      // 5 条 relation 同一秒插入(同 ms epoch → 同 datetime)。
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) {
        const target = repo.createEntity({ name: `TieTarget${i}` });
        ids.push(insertRelation(raw, anchor.id, target.id, now));
      }
      // LIMIT 3 期望返回 id 最大的 3 个(最近插入的 3 个)。
      const out = repo.findRecentRelations({ sinceMs: now - 1_000, limit: 3 });
      expect(out).toHaveLength(3);
      const expectedTopIds = ids.slice(-3).reverse(); // [id5, id4, id3]
      expect(out.map((r) => r.id)).toEqual(expectedTopIds);
    });

    it('returns one row per relation even when entities have many categories (no cartesian)', () => {
      // CTE 把 LIMIT 提到 JOIN categories 之前,关系不会因类别多被笛卡尔积放大 →
      // GROUP BY r.id 后行数 = relation 数,而不是 |source.cats| × |target.cats|。
      const raw = getRawDatabase(t.db);
      const e1 = repo.createEntity({ name: 'CartA' });
      const e2 = repo.createEntity({ name: 'CartB' });
      // 给两个 entity 各 4 个 category — 无防护时会扩成 16 行。
      for (let i = 0; i < 4; i++) {
        repo.linkEntityToCategory(e1.id, catRepo.ensureCategoryPath(`cart/a/${i}`));
        repo.linkEntityToCategory(e2.id, catRepo.ensureCategoryPath(`cart/b/${i}`));
      }
      const now = Date.now();
      insertRelation(raw, e1.id, e2.id, now);

      const out = repo.findRecentRelations({ sinceMs: now - 1_000, limit: 10 });
      expect(out).toHaveLength(1);
      expect(out[0].source.categoryPaths).toHaveLength(4);
      expect(out[0].target.categoryPaths).toHaveLength(4);
    });
  });

  describe('findEntitiesByNames', () => {
    it('returns empty array when input is empty', () => {
      expect(repo.findEntitiesByNames([])).toEqual([]);
    });

    it('returns entities matching given names case-insensitive', () => {
      const a = repo.createEntity({ name: 'Anthropic' });
      const b = repo.createEntity({ name: 'OpenAI' });
      repo.createEntity({ name: 'Unrelated' });

      const result = repo.findEntitiesByNames(['anthropic', 'OPENAI', 'nonexistent']);

      expect(result).toHaveLength(2);
      const ids = result.map((r) => r.id).sort();
      expect(ids).toEqual([a.id, b.id].sort());
      expect(result.every((r) => typeof r.name === 'string' && r.name.length > 0)).toBe(true);
    });

    it('handles unicode (CJK) names case-insensitive (lowering applied to ASCII only)', () => {
      const ent = repo.createEntity({ name: 'Anthropic公司' });
      const result = repo.findEntitiesByNames(['anthropic公司']);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(ent.id);
    });

    it('matches names containing spaces / punctuation', () => {
      const claude = repo.createEntity({ name: 'Claude Code' });
      const openai = repo.createEntity({ name: 'OpenAI, Inc.' });
      const gpt = repo.createEntity({ name: 'gpt-4o-mini' });
      const node = repo.createEntity({ name: 'Node.js' });
      const result = repo.findEntitiesByNames([
        'claude code',
        'openai, inc.',
        'GPT-4O-MINI',
        'node.js',
      ]);
      expect(result.map((r) => r.id).sort()).toEqual(
        [claude.id, openai.id, gpt.id, node.id].sort(),
      );
    });

    it('deduplicates input names before query', () => {
      const ent = repo.createEntity({ name: 'Claude' });
      const result = repo.findEntitiesByNames(['claude', 'Claude', 'CLAUDE']);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(ent.id);
    });
  });
});
