import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteNotesRepository } from '../../src/db/repositories/notes.repository';
import { entities, sources } from '../../src/db/schema';
import { utcNowMs } from '../../src/db/timestamp';
import { createNote } from '../../src/notes/create';
import { createTestDB, type TestDB } from '../helpers/test-db';

describe('createNote', () => {
  let t: TestDB;
  let repo: SqliteNotesRepository;

  beforeEach(() => {
    t = createTestDB();
    repo = new SqliteNotesRepository(t.db);
  });
  afterEach(() => t.cleanup());

  it('creates a note with minimal input (content only) and default subtype', () => {
    const detail = createNote({ content: 'hello world' }, { db: t.db, repo });
    expect(detail.id).toBeGreaterThan(0);
    expect(detail.content).toBe('hello world');
    expect(detail.subtype).toBe('note');
    expect(detail.pinned).toBe(false);
    expect(detail.archived).toBe(false);
    expect(detail.tags).toEqual([]);
    expect(detail.linkedEntities).toEqual([]);
    expect(detail.linkedSources).toEqual([]);
    expect(detail.createdAt).toBeGreaterThan(0);
    expect(detail.updatedAt).toBe(detail.createdAt);
  });

  it('creates a note with explicit subtype', () => {
    const detail = createNote({ content: 'remember to ship', subtype: 'memo' }, { db: t.db, repo });
    expect(detail.subtype).toBe('memo');
  });

  it('inserts tags into note_tags (trim+lowercase+dedup)', () => {
    const detail = createNote(
      { content: 'tagged', tags: ['foo', 'bar', '  Foo  ', '', '   '] },
      { db: t.db, repo },
    );
    expect(detail.tags.sort()).toEqual(['bar', 'foo']);
  });

  it('soft-validates linkedEntityIds (silently drops non-existent and dedupes)', () => {
    const now = utcNowMs();
    const inserted = t.db
      .insert(entities)
      .values({ name: 'EntityA', createdAt: now, updatedAt: now })
      .returning({ id: entities.id })
      .all();
    const entityId = inserted[0].id;

    const detail = createNote(
      { content: 'with entities', linkedEntityIds: [entityId, entityId, 99999] },
      { db: t.db, repo },
    );
    expect(detail.linkedEntities.map((e) => e.id)).toEqual([entityId]);
  });

  it('links to source via note_sources when linkedSourceId valid', () => {
    const inserted = t.db
      .insert(sources)
      .values({
        kind: 'user',
        rawContent: 'src-content',
        status: 'confirmed',
      })
      .returning({ id: sources.id })
      .all();
    const sourceId = inserted[0].id;

    const detail = createNote(
      { content: 'about source', linkedSourceId: sourceId },
      { db: t.db, repo },
    );
    expect(detail.linkedSources).toHaveLength(1);
    expect(detail.linkedSources[0].id).toBe(sourceId);
    expect(detail.linkedSources[0].relation).toBe('reference');
  });

  it('silently ignores linkedSourceId pointing to non-existent source', () => {
    const detail = createNote(
      { content: 'about ghost source', linkedSourceId: 99999 },
      { db: t.db, repo },
    );
    expect(detail.linkedSources).toEqual([]);
  });

  it('persists sourceMessageId when reference exists', () => {
    const raw = (t.db as unknown as { $client: import('better-sqlite3').Database }).$client;
    raw.exec(`INSERT INTO conversations (session_key, channel_id) VALUES ('s', 'web')`);
    const convRow = raw.prepare(`SELECT id FROM conversations`).get() as { id: number };
    const msgInsert = raw.prepare(
      `INSERT INTO conversation_messages (conversation_id, role, content) VALUES (?, ?, ?) RETURNING id`,
    );
    const msgRow = msgInsert.get(convRow.id, 'user', 'm') as { id: number };

    const detail = createNote(
      { content: 'from msg', sourceMessageId: msgRow.id },
      { db: t.db, repo },
    );
    expect(detail.sourceMessageId).toBe(msgRow.id);
  });
});
