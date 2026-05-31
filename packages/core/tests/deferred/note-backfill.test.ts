import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  entities,
  knowledgePoints,
  noteEntities,
  noteSources,
  notes,
  sourceEntityPoints,
  sources,
} from '../../src/db/schema';
import { backfillNoteEntitiesForSource } from '../../src/notes/backfill';
import { createTestDB } from '../helpers/test-db';

describe('backfillNoteEntitiesForSource', () => {
  it('confirmed source: 给关联 note 写 entity link', () => {
    const tdb = createTestDB();
    try {
      const [src] = tdb.db
        .insert(sources)
        .values({
          kind: 'external',
          normalizedUrl: 'http://x',
          originalUrl: 'http://x',
          status: 'confirmed',
        })
        .returning()
        .all();
      const [e1] = tdb.db.insert(entities).values({ name: 'E1' }).returning().all();
      const [e2] = tdb.db.insert(entities).values({ name: 'E2' }).returning().all();
      const [p] = tdb.db
        .insert(knowledgePoints)
        .values({ content: 'p', type: 'fact' })
        .returning()
        .all();
      tdb.db
        .insert(sourceEntityPoints)
        .values([
          { sourceId: src.id, entityId: e1.id, pointId: p.id, judgment: 'new' },
          { sourceId: src.id, entityId: e2.id, pointId: p.id, judgment: 'new' },
        ])
        .run();

      // intent-note 在 source 还 processing 时建的，entity 留空，只写 note_sources
      const [n] = tdb.db.insert(notes).values({ content: 'about it' }).returning().all();
      tdb.db
        .insert(noteSources)
        .values({ noteId: n.id, sourceId: src.id, relation: 'reference' })
        .run();

      const result = backfillNoteEntitiesForSource(src.id, tdb.db);
      expect(result.notesUpdated).toBe(1);
      expect(result.entityLinksAdded).toBe(2);

      const links = tdb.db.select().from(noteEntities).where(eq(noteEntities.noteId, n.id)).all();
      expect(links.map((l) => l.entityId).sort((a, b) => a - b)).toEqual(
        [e1.id, e2.id].sort((a, b) => a - b),
      );
    } finally {
      tdb.cleanup();
    }
  });

  it('source 无 entity → 不写 note_entities，notesUpdated=1 entityLinksAdded=0', () => {
    const tdb = createTestDB();
    try {
      const [src] = tdb.db
        .insert(sources)
        .values({
          kind: 'external',
          normalizedUrl: 'http://y',
          originalUrl: 'http://y',
          status: 'confirmed_empty',
        })
        .returning()
        .all();
      const [n] = tdb.db.insert(notes).values({ content: 'q' }).returning().all();
      tdb.db
        .insert(noteSources)
        .values({ noteId: n.id, sourceId: src.id, relation: 'reference' })
        .run();

      const result = backfillNoteEntitiesForSource(src.id, tdb.db);
      expect(result.notesUpdated).toBe(1);
      expect(result.entityLinksAdded).toBe(0);
    } finally {
      tdb.cleanup();
    }
  });

  it('幂等：第二次调用不再加 link', () => {
    const tdb = createTestDB();
    try {
      const [src] = tdb.db
        .insert(sources)
        .values({
          kind: 'external',
          normalizedUrl: 'http://z',
          originalUrl: 'http://z',
          status: 'confirmed',
        })
        .returning()
        .all();
      const [e1] = tdb.db.insert(entities).values({ name: 'E1' }).returning().all();
      const [p] = tdb.db
        .insert(knowledgePoints)
        .values({ content: 'p', type: 'fact' })
        .returning()
        .all();
      tdb.db
        .insert(sourceEntityPoints)
        .values([{ sourceId: src.id, entityId: e1.id, pointId: p.id, judgment: 'new' }])
        .run();
      const [n] = tdb.db.insert(notes).values({ content: 'x' }).returning().all();
      tdb.db
        .insert(noteSources)
        .values({ noteId: n.id, sourceId: src.id, relation: 'reference' })
        .run();

      backfillNoteEntitiesForSource(src.id, tdb.db);
      const second = backfillNoteEntitiesForSource(src.id, tdb.db);
      expect(second.entityLinksAdded).toBe(0);
    } finally {
      tdb.cleanup();
    }
  });

  it('source 无关联 note → noop 返 0/0', () => {
    const tdb = createTestDB();
    try {
      const [src] = tdb.db
        .insert(sources)
        .values({
          kind: 'external',
          normalizedUrl: 'http://a',
          originalUrl: 'http://a',
          status: 'confirmed',
        })
        .returning()
        .all();
      const result = backfillNoteEntitiesForSource(src.id, tdb.db);
      expect(result.notesUpdated).toBe(0);
      expect(result.entityLinksAdded).toBe(0);
    } finally {
      tdb.cleanup();
    }
  });
});
