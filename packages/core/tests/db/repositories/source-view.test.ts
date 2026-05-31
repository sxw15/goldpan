import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteCategoryRepository } from '../../../src/db/repositories/category.repository.js';
import { SqliteSourceRepository } from '../../../src/db/repositories/source.repository.js';
import { SqliteSourceViewRepository } from '../../../src/db/repositories/source-view.repository.js';
import {
  entities,
  entityCategories,
  knowledgePoints,
  pointTags,
  sourceEntityPoints,
  tags,
} from '../../../src/db/schema.js';
import { utcNowMs } from '../../../src/db/timestamp.js';
import { createTestDB, type TestDB } from '../../helpers/test-db.js';

function insertEntity(db: any, data: { name: string; keywords?: string; aliases?: string }) {
  const [row] = db
    .insert(entities)
    .values({
      name: data.name,
      keywords: data.keywords ?? '[]',
      aliases: data.aliases ?? '[]',
      createdAt: utcNowMs(),
      updatedAt: utcNowMs(),
    })
    .returning()
    .all();
  return row;
}

function insertPoint(db: any, data: { content: string; type: string }) {
  const [row] = db
    .insert(knowledgePoints)
    .values({
      content: data.content,
      type: data.type,
      status: 'active',
      createdAt: utcNowMs(),
      updatedAt: utcNowMs(),
    })
    .returning()
    .all();
  return row;
}

function insertSep(db: any, sourceId: number, entityId: number, pointId: number, judgment = 'new') {
  db.insert(sourceEntityPoints)
    .values({ sourceId, entityId, pointId, judgment })
    .onConflictDoNothing()
    .run();
}

function discardPoint(db: any, pointId: number) {
  db.update(knowledgePoints)
    .set({ status: 'discarded', updatedAt: utcNowMs() })
    .where(eq(knowledgePoints.id, pointId))
    .run();
}

function attachPointTags(db: any, pointId: number, tagNames: string[]): void {
  for (const name of tagNames) {
    const [tagRow] = db.insert(tags).values({ name }).returning().all();
    db.insert(pointTags).values({ pointId, tagId: tagRow.id }).run();
  }
}

function linkEntityCategory(db: any, entityId: number, categoryId: number) {
  db.insert(entityCategories).values({ entityId, categoryId }).onConflictDoNothing().run();
}

describe('SourceViewRepository', () => {
  let t: TestDB;
  let sourceViewRepo: SqliteSourceViewRepository;
  let sourceRepo: SqliteSourceRepository;
  let categoryRepo: SqliteCategoryRepository;

  beforeEach(() => {
    t = createTestDB();
    sourceViewRepo = new SqliteSourceViewRepository(t.db);
    sourceRepo = new SqliteSourceRepository(t.db);
    categoryRepo = new SqliteCategoryRepository(t.db);
  });

  afterEach(() => {
    t.cleanup();
  });

  function createExternalSource(title: string, url: string) {
    const src = sourceRepo.create({
      kind: 'external',
      normalizedUrl: url,
      originalUrl: `https://${url}`,
    });
    sourceRepo.updateAfterCollecting(src.id, {
      title,
      rawContent: `# ${title}\n\nSome content about ${title}.`,
    });
    sourceRepo.updateStatus(src.id, 'confirmed');
    return sourceRepo.getById(src.id)!;
  }

  describe('listSourceViewWithCategories', () => {
    it('returns empty array when no confirmed sources', () => {
      expect(sourceViewRepo.listSourceViewWithCategories()).toEqual([]);
    });

    it('returns confirmed sources with no categories as categoryIds=[]', () => {
      createExternalSource('Test Article', 'example.com/test');
      const notes = sourceViewRepo.listSourceViewWithCategories();
      expect(notes).toHaveLength(1);
      expect(notes[0].title).toBe('Test Article');
      expect(notes[0].kind).toBe('external');
      expect(notes[0].categoryIds).toEqual([]);
    });

    it('returns category IDs from entity associations', () => {
      const src = createExternalSource('AI Article', 'example.com/ai');
      const catId = categoryRepo.ensureCategoryPath('Tech/AI');
      const ent = insertEntity(t.db, { name: 'GPT' });
      const pt = insertPoint(t.db, { content: 'GPT is a model', type: 'fact' });
      insertSep(t.db, src.id, ent.id, pt.id);
      linkEntityCategory(t.db, ent.id, catId);

      const notes = sourceViewRepo.listSourceViewWithCategories();
      expect(notes).toHaveLength(1);
      expect(notes[0].categoryIds).toContain(catId);
    });

    it('excludes non-confirmed sources', () => {
      sourceRepo.create({
        kind: 'external',
        normalizedUrl: 'processing.com',
        originalUrl: 'https://processing.com',
      });
      expect(sourceViewRepo.listSourceViewWithCategories()).toEqual([]);
    });

    it('includes confirmed_empty sources', () => {
      const src = sourceRepo.create({
        kind: 'external',
        normalizedUrl: 'empty.com',
        originalUrl: 'https://empty.com',
      });
      sourceRepo.updateStatus(src.id, 'confirmed_empty');
      const notes = sourceViewRepo.listSourceViewWithCategories();
      expect(notes).toHaveLength(1);
    });

    it('deduplicates category IDs when entity has multiple SEP rows', () => {
      const src = createExternalSource('Multi', 'example.com/multi');
      const catId = categoryRepo.ensureCategoryPath('Tech');
      const ent = insertEntity(t.db, { name: 'React' });
      const pt1 = insertPoint(t.db, { content: 'fact 1', type: 'fact' });
      const pt2 = insertPoint(t.db, { content: 'fact 2', type: 'fact' });
      insertSep(t.db, src.id, ent.id, pt1.id);
      insertSep(t.db, src.id, ent.id, pt2.id);
      linkEntityCategory(t.db, ent.id, catId);

      const notes = sourceViewRepo.listSourceViewWithCategories();
      expect(notes[0].categoryIds).toEqual([catId]);
    });

    it('excludes categories from entities with only discarded points', () => {
      const src = createExternalSource('Stale', 'example.com/stale');
      const catId = categoryRepo.ensureCategoryPath('Stale/Cat');
      const ent = insertEntity(t.db, { name: 'StaleEnt' });
      const pt = insertPoint(t.db, { content: 'gone', type: 'fact' });
      insertSep(t.db, src.id, ent.id, pt.id);
      linkEntityCategory(t.db, ent.id, catId);
      discardPoint(t.db, pt.id);

      const notes = sourceViewRepo.listSourceViewWithCategories();
      expect(notes).toHaveLength(1);
      expect(notes[0].categoryIds).toEqual([]);
    });
  });

  describe('getSourceViewDetail', () => {
    it('returns undefined for non-existent source', () => {
      expect(sourceViewRepo.getSourceViewDetail(999)).toBeUndefined();
    });

    it('returns undefined for non-confirmed source', () => {
      const src = sourceRepo.create({
        kind: 'external',
        normalizedUrl: 'test.com',
        originalUrl: 'https://test.com',
      });
      expect(sourceViewRepo.getSourceViewDetail(src.id)).toBeUndefined();
    });

    it('returns source with empty entities for confirmed_empty source', () => {
      const src = sourceRepo.create({
        kind: 'external',
        normalizedUrl: 'empty.com',
        originalUrl: 'https://empty.com',
      });
      sourceRepo.updateStatus(src.id, 'confirmed_empty');
      const detail = sourceViewRepo.getSourceViewDetail(src.id);
      expect(detail).toBeDefined();
      expect(detail!.source.id).toBe(src.id);
      expect(detail!.entities).toEqual([]);
    });

    it('returns entities grouped with their active points', () => {
      const src = createExternalSource('Tech Article', 'example.com/tech');
      const ent = insertEntity(t.db, { name: 'React' });
      const pt1 = insertPoint(t.db, { content: 'React is a library', type: 'fact' });
      const pt2 = insertPoint(t.db, { content: 'React is great', type: 'opinion' });
      insertSep(t.db, src.id, ent.id, pt1.id);
      insertSep(t.db, src.id, ent.id, pt2.id);

      const detail = sourceViewRepo.getSourceViewDetail(src.id);
      expect(detail!.entities).toHaveLength(1);
      expect(detail!.entities[0].entityName).toBe('React');
      expect(detail!.entities[0].points).toHaveLength(2);
    });

    it('includes category paths', () => {
      const src = createExternalSource('Cat Article', 'example.com/cat');
      const catId = categoryRepo.ensureCategoryPath('Tech/Frontend');
      const ent = insertEntity(t.db, { name: 'Vue' });
      const pt = insertPoint(t.db, { content: 'Vue fact', type: 'fact' });
      insertSep(t.db, src.id, ent.id, pt.id);
      linkEntityCategory(t.db, ent.id, catId);

      const detail = sourceViewRepo.getSourceViewDetail(src.id);
      expect(detail!.categoryPaths).toContain('/Tech/Frontend');
    });

    it('excludes category paths from entities with only discarded points', () => {
      const src = createExternalSource('Stale Cat', 'example.com/stalecat');
      const catId = categoryRepo.ensureCategoryPath('Stale/Path');
      const ent = insertEntity(t.db, { name: 'GoneEnt' });
      const pt = insertPoint(t.db, { content: 'removed', type: 'fact' });
      insertSep(t.db, src.id, ent.id, pt.id);
      linkEntityCategory(t.db, ent.id, catId);
      discardPoint(t.db, pt.id);

      const detail = sourceViewRepo.getSourceViewDetail(src.id);
      expect(detail!.entities).toEqual([]);
      expect(detail!.categoryPaths).toEqual([]);
    });
  });

  describe('getSourceViewTags', () => {
    it('returns empty array for source with no entities', () => {
      const src = createExternalSource('No Entities', 'example.com/noent');
      expect(sourceViewRepo.getSourceViewTags(src.id)).toEqual([]);
    });

    it('aggregates keywords and aliases from all entities', () => {
      const src = createExternalSource('Tagged', 'example.com/tagged');
      const ent1 = insertEntity(t.db, {
        name: 'React',
        keywords: '["javascript","ui"]',
        aliases: '["ReactJS"]',
      });
      const ent2 = insertEntity(t.db, {
        name: 'Vue',
        keywords: '["javascript","framework"]',
        aliases: '[]',
      });
      const pt1 = insertPoint(t.db, { content: 'fact1', type: 'fact' });
      const pt2 = insertPoint(t.db, { content: 'fact2', type: 'fact' });
      insertSep(t.db, src.id, ent1.id, pt1.id);
      insertSep(t.db, src.id, ent2.id, pt2.id);

      const tags = sourceViewRepo.getSourceViewTags(src.id);
      expect(tags).toContain('javascript');
      expect(tags).toContain('ui');
      expect(tags).toContain('framework');
      expect(tags).toContain('ReactJS');
    });

    it('deduplicates tags', () => {
      const src = createExternalSource('Dup Tags', 'example.com/dup');
      const ent1 = insertEntity(t.db, { name: 'A', keywords: '["js"]' });
      const ent2 = insertEntity(t.db, { name: 'B', keywords: '["js"]' });
      const pt1 = insertPoint(t.db, { content: 'f1', type: 'fact' });
      const pt2 = insertPoint(t.db, { content: 'f2', type: 'fact' });
      insertSep(t.db, src.id, ent1.id, pt1.id);
      insertSep(t.db, src.id, ent2.id, pt2.id);

      const tags = sourceViewRepo.getSourceViewTags(src.id);
      const jsCount = tags.filter((t) => t === 'js').length;
      expect(jsCount).toBe(1);
    });

    it('excludes tags from entities with only discarded points', () => {
      const src = createExternalSource('Stale Tags', 'example.com/staletags');
      const ent = insertEntity(t.db, { name: 'Gone', keywords: '["stale"]', aliases: '["Old"]' });
      const pt = insertPoint(t.db, { content: 'discarded', type: 'fact' });
      insertSep(t.db, src.id, ent.id, pt.id);
      discardPoint(t.db, pt.id);

      expect(sourceViewRepo.getSourceViewTags(src.id)).toEqual([]);
    });

    it('aggregates hashtag-style point_tags from active opinion points', () => {
      // The pipeline writes opinion-only point_tags via storing.ts; without
      // joining them here, SourceViewDetail would render an empty tag chip row
      // even after a successful opinion submit.
      const src = createExternalSource('Opinion Tagged', 'example.com/op');
      const ent = insertEntity(t.db, { name: 'Trend', keywords: '["industry"]' });
      const pt = insertPoint(t.db, { content: 'AI is overhyped', type: 'opinion' });
      insertSep(t.db, src.id, ent.id, pt.id);
      attachPointTags(t.db, pt.id, ['趋势判断', '风险提示']);

      const tagList = sourceViewRepo.getSourceViewTags(src.id);
      expect(tagList).toContain('industry');
      expect(tagList).toContain('趋势判断');
      expect(tagList).toContain('风险提示');
    });

    it('drops point_tags when the underlying point is soft-deleted', () => {
      const src = createExternalSource('Soft-deleted Point', 'example.com/sd');
      const ent = insertEntity(t.db, { name: 'X' });
      const pt = insertPoint(t.db, { content: 'old opinion', type: 'opinion' });
      insertSep(t.db, src.id, ent.id, pt.id);
      attachPointTags(t.db, pt.id, ['stale_tag']);
      discardPoint(t.db, pt.id);

      expect(sourceViewRepo.getSourceViewTags(src.id)).toEqual([]);
    });
  });

  describe('getSourceViewStats', () => {
    it('returns zeros when no confirmed sources', () => {
      expect(sourceViewRepo.getSourceViewStats()).toEqual({ sourceCount: 0, pointCount: 0 });
    });

    it('counts confirmed sources and active points', () => {
      const src = createExternalSource('Stats', 'example.com/stats');
      const ent = insertEntity(t.db, { name: 'E' });
      const pt = insertPoint(t.db, { content: 'c', type: 'fact' });
      insertSep(t.db, src.id, ent.id, pt.id);

      const stats = sourceViewRepo.getSourceViewStats();
      expect(stats.sourceCount).toBe(1);
      expect(stats.pointCount).toBe(1);
    });
  });

  describe('getRecentSourceViews', () => {
    it('returns notes ordered by createdAt descending', () => {
      createExternalSource('Old', 'example.com/old');
      createExternalSource('New', 'example.com/new');

      const notes = sourceViewRepo.getRecentSourceViews(10);
      expect(notes).toHaveLength(2);
      expect(notes[0].title).toBe('New');
      expect(notes[1].title).toBe('Old');
    });

    it('respects the limit parameter', () => {
      createExternalSource('A', 'example.com/a');
      createExternalSource('B', 'example.com/b');
      createExternalSource('C', 'example.com/c');

      const notes = sourceViewRepo.getRecentSourceViews(2);
      expect(notes).toHaveLength(2);
    });
  });
});
