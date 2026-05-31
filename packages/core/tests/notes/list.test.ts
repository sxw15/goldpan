import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRawDatabase } from '../../src/db/connection';
import { SqliteNotesRepository } from '../../src/db/repositories/notes.repository';
import { entities, sources } from '../../src/db/schema';
import { utcNowMs } from '../../src/db/timestamp';
import { createNote } from '../../src/notes/create';
import { listNotes } from '../../src/notes/list';
import { updateNote } from '../../src/notes/update';
import { createTestDB, type TestDB } from '../helpers/test-db';

describe('listNotes', () => {
  let t: TestDB;
  let repo: SqliteNotesRepository;

  beforeEach(() => {
    t = createTestDB();
    repo = new SqliteNotesRepository(t.db);
  });
  afterEach(() => t.cleanup());

  it('returns empty for empty DB', () => {
    const r = listNotes({}, { db: t.db, repo });
    expect(r.data).toEqual([]);
    expect(r.nextCursor).toBeNull();
  });

  it('filters by single subtype', () => {
    createNote({ content: 'a', subtype: 'memo' }, { db: t.db, repo });
    createNote({ content: 'b', subtype: 'note' }, { db: t.db, repo });
    createNote({ content: 'c', subtype: 'memo' }, { db: t.db, repo });

    const r = listNotes({ subtype: 'memo' }, { db: t.db, repo });
    expect(r.data).toHaveLength(2);
    expect(r.data.every((n) => n.subtype === 'memo')).toBe(true);
  });

  it('filters by subtype array (multi)', () => {
    createNote({ content: 'a', subtype: 'memo' }, { db: t.db, repo });
    createNote({ content: 'b', subtype: 'note' }, { db: t.db, repo });
    createNote({ content: 'c', subtype: 'note' }, { db: t.db, repo });

    const r = listNotes({ subtype: ['memo', 'note'] }, { db: t.db, repo });
    expect(r.data).toHaveLength(3);
  });

  it('filters by tag', () => {
    createNote({ content: 'a', tags: ['x', 'y'] }, { db: t.db, repo });
    createNote({ content: 'b', tags: ['x'] }, { db: t.db, repo });
    createNote({ content: 'c', tags: ['z'] }, { db: t.db, repo });

    const r = listNotes({ tag: 'x' }, { db: t.db, repo });
    expect(r.data).toHaveLength(2);
  });

  it('filters by entityId via note_entities join', () => {
    const now = utcNowMs();
    const [a, b] = t.db
      .insert(entities)
      .values([
        { name: 'EA', createdAt: now, updatedAt: now },
        { name: 'EB', createdAt: now, updatedAt: now },
      ])
      .returning({ id: entities.id })
      .all();

    createNote({ content: 'a', linkedEntityIds: [a.id] }, { db: t.db, repo });
    createNote({ content: 'b', linkedEntityIds: [b.id] }, { db: t.db, repo });
    createNote({ content: 'c', linkedEntityIds: [a.id, b.id] }, { db: t.db, repo });

    const r = listNotes({ entityId: a.id }, { db: t.db, repo });
    expect(r.data).toHaveLength(2);
  });

  it('filters by sourceId via note_sources join', () => {
    const [src] = t.db
      .insert(sources)
      .values({ kind: 'user', rawContent: 'src', status: 'confirmed' })
      .returning({ id: sources.id })
      .all();
    const linked = createNote(
      { content: 'about source', linkedSourceId: src.id },
      { db: t.db, repo },
    );
    createNote({ content: 'not about source' }, { db: t.db, repo });

    const r = listNotes({ sourceId: src.id }, { db: t.db, repo });
    expect(r.data.map((n) => n.id)).toEqual([linked.id]);
  });

  it('excludes archived by default', () => {
    const a = createNote({ content: 'visible' }, { db: t.db, repo });
    const b = createNote({ content: 'hidden' }, { db: t.db, repo });
    repo.update(b.id, { archived: true });

    const r = listNotes({}, { db: t.db, repo });
    expect(r.data).toHaveLength(1);
    expect(r.data[0].id).toBe(a.id);
  });

  it('returns only archived when archived=true', () => {
    createNote({ content: 'visible' }, { db: t.db, repo });
    const b = createNote({ content: 'hidden' }, { db: t.db, repo });
    repo.update(b.id, { archived: true });

    const r = listNotes({ archived: true }, { db: t.db, repo });
    expect(r.data).toHaveLength(1);
    expect(r.data[0].id).toBe(b.id);
  });

  it('search path matches content via FTS5', () => {
    createNote({ content: 'hello world TypeScript' }, { db: t.db, repo });
    createNote({ content: 'goodbye TypeScript' }, { db: t.db, repo });
    createNote({ content: 'unrelated content' }, { db: t.db, repo });

    const r = listNotes({ search: 'TypeScript' }, { db: t.db, repo });
    expect(r.data).toHaveLength(2);
    expect(r.nextCursor).toBeNull();
  });

  it('search returns empty when no token survives sanitization', () => {
    createNote({ content: 'real content' }, { db: t.db, repo });
    const r = listNotes({ search: '!!!' }, { db: t.db, repo });
    expect(r.data).toEqual([]);
  });

  it('search filters by subtype', () => {
    createNote({ content: 'shared keyword', subtype: 'memo' }, { db: t.db, repo });
    createNote({ content: 'shared keyword', subtype: 'note' }, { db: t.db, repo });

    const r = listNotes({ search: 'shared', subtype: 'memo' }, { db: t.db, repo });
    expect(r.data).toHaveLength(1);
    expect(r.data[0].subtype).toBe('memo');
  });

  it('search applies tag, entity, source, and pinned filters', () => {
    const now = utcNowMs();
    const [entity] = t.db
      .insert(entities)
      .values({ name: 'SearchEntity', createdAt: now, updatedAt: now })
      .returning({ id: entities.id })
      .all();
    const [src] = t.db
      .insert(sources)
      .values({ kind: 'user', rawContent: 'src', status: 'confirmed' })
      .returning({ id: sources.id })
      .all();

    const target = createNote(
      {
        content: 'needle target',
        tags: ['search-tag'],
        linkedEntityIds: [entity.id],
        linkedSourceId: src.id,
      },
      { db: t.db, repo },
    );
    repo.update(target.id, { pinned: true });

    createNote(
      {
        content: 'needle unpinned',
        tags: ['search-tag'],
        linkedEntityIds: [entity.id],
        linkedSourceId: src.id,
      },
      { db: t.db, repo },
    );
    const wrongTag = createNote(
      {
        content: 'needle wrong-tag',
        tags: ['other-tag'],
        linkedEntityIds: [entity.id],
        linkedSourceId: src.id,
      },
      { db: t.db, repo },
    );
    repo.update(wrongTag.id, { pinned: true });

    const r = listNotes(
      {
        search: 'needle',
        pinned: true,
        tag: 'search-tag',
        entityId: entity.id,
        sourceId: src.id,
      },
      { db: t.db, repo },
    );
    expect(r.data.map((n) => n.id)).toEqual([target.id]);
  });

  it('paginates with createdAt cursor', () => {
    const raw = getRawDatabase(t.db);
    const created: number[] = [];
    for (let i = 0; i < 5; i++) {
      const n = createNote({ content: `note ${i}` }, { db: t.db, repo });
      created.push(n.id);
    }
    // Re-stamp createdAt with 10s gaps so newest-first ordering is deterministic.
    const base = Date.now();
    for (let i = 0; i < created.length; i++) {
      raw
        .prepare('UPDATE notes SET created_at = ? WHERE id = ?')
        .run(base - i * 10_000, created[i]);
    }

    const page1 = listNotes({ limit: 2 }, { db: t.db, repo });
    expect(page1.data).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = listNotes(
      { limit: 2, cursor: page1.nextCursor ?? undefined },
      { db: t.db, repo },
    );
    expect(page2.data).toHaveLength(2);

    // No overlap
    const ids1 = new Set(page1.data.map((n) => n.id));
    expect(page2.data.every((n) => !ids1.has(n.id))).toBe(true);
  });

  it('paginates through rows that share createdAt', () => {
    const raw = getRawDatabase(t.db);
    const ids = [0, 1, 2].map((i) => createNote({ content: `tie ${i}` }, { db: t.db, repo }).id);
    const stamp = Date.now();
    for (const id of ids) {
      raw.prepare('UPDATE notes SET created_at = ? WHERE id = ?').run(stamp, id);
    }

    const page1 = listNotes({ limit: 2 }, { db: t.db, repo });
    const page2 = listNotes(
      { limit: 2, cursor: page1.nextCursor ?? undefined },
      { db: t.db, repo },
    );

    expect(page1.data.map((n) => n.id)).toEqual([ids[2], ids[1]]);
    expect(page2.data.map((n) => n.id)).toEqual([ids[0]]);
  });

  it('sorts by createdAt desc by default', () => {
    const a = createNote({ content: 'a' }, { db: t.db, repo });
    const b = createNote({ content: 'b' }, { db: t.db, repo });
    // shift a backwards so b is the newest
    getRawDatabase(t.db)
      .prepare('UPDATE notes SET created_at = ? WHERE id = ?')
      .run(a.createdAt - 1000, a.id);

    const r = listNotes({}, { db: t.db, repo });
    expect(r.data[0].id).toBe(b.id);
    expect(r.data[1].id).toBe(a.id);
  });
});

describe('listNotes dueBefore + hasReminder filters (P7.4)', () => {
  let t: TestDB;
  let repo: SqliteNotesRepository;

  beforeEach(() => {
    t = createTestDB();
    repo = new SqliteNotesRepository(t.db);
  });
  afterEach(() => t.cleanup());

  it('dueBefore filters notes with due_at <= cutoff', () => {
    const a = createNote({ content: 'a', subtype: 'memo' }, { db: t.db, repo });
    const b = createNote({ content: 'b', subtype: 'memo' }, { db: t.db, repo });
    updateNote(a.id, { dueAt: 1_000 }, { db: t.db, repo });
    updateNote(b.id, { dueAt: 5_000 }, { db: t.db, repo });

    const out = repo.list({ subtype: 'memo', dueBefore: 2_000 });
    const ids = out.data.map((n) => n.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it('hasReminder=true returns only notes with due set AND reminded null', () => {
    const due = createNote({ content: 'due', subtype: 'memo' }, { db: t.db, repo });
    const remind = createNote({ content: 'remind', subtype: 'memo' }, { db: t.db, repo });
    const noDue = createNote({ content: 'nodue', subtype: 'memo' }, { db: t.db, repo });
    updateNote(due.id, { dueAt: 1_000 }, { db: t.db, repo });
    updateNote(remind.id, { dueAt: 1_000 }, { db: t.db, repo });
    repo.markReminded(remind.id);

    const out = repo.list({ subtype: 'memo', hasReminder: true });
    const ids = out.data.map((n) => n.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(remind.id);
    expect(ids).not.toContain(noDue.id);
  });

  it('applies dueBefore + hasReminder filters on the search path too', () => {
    const due = createNote({ content: 'needle due', subtype: 'memo' }, { db: t.db, repo });
    const future = createNote({ content: 'needle future', subtype: 'memo' }, { db: t.db, repo });
    const reminded = createNote(
      { content: 'needle reminded', subtype: 'memo' },
      { db: t.db, repo },
    );
    updateNote(due.id, { dueAt: 1_000 }, { db: t.db, repo });
    updateNote(future.id, { dueAt: 5_000 }, { db: t.db, repo });
    updateNote(reminded.id, { dueAt: 1_000 }, { db: t.db, repo });
    repo.markReminded(reminded.id, { expectedDueAt: 1_000 });

    const out = repo.list({
      search: 'needle',
      subtype: 'memo',
      dueBefore: 2_000,
      hasReminder: true,
    });
    expect(out.data.map((n) => n.id)).toEqual([due.id]);
  });

  it('orders pending reminders by dueAt ascending before applying limit', () => {
    const early = createNote({ content: 'early', subtype: 'memo' }, { db: t.db, repo });
    const late = createNote({ content: 'late', subtype: 'memo' }, { db: t.db, repo });
    const middle = createNote({ content: 'middle', subtype: 'memo' }, { db: t.db, repo });
    updateNote(early.id, { dueAt: 1_000 }, { db: t.db, repo });
    updateNote(middle.id, { dueAt: 2_000 }, { db: t.db, repo });
    updateNote(late.id, { dueAt: 3_000 }, { db: t.db, repo });

    const out = repo.list({
      subtype: 'memo',
      dueBefore: 10_000,
      hasReminder: true,
      limit: 2,
    });
    expect(out.data.map((n) => n.id)).toEqual([early.id, middle.id]);
    expect(out.nextCursor).toBeNull();
  });
});
