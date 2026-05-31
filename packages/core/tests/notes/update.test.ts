import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRawDatabase } from '../../src/db/connection';
import { SqliteNotesRepository } from '../../src/db/repositories/notes.repository';
import { entities } from '../../src/db/schema';
import { utcNowMs } from '../../src/db/timestamp';
import { createNote } from '../../src/notes/create';
import { updateNote } from '../../src/notes/update';
import { createTestDB, type TestDB } from '../helpers/test-db';

describe('updateNote', () => {
  let t: TestDB;
  let repo: SqliteNotesRepository;

  beforeEach(() => {
    t = createTestDB();
    repo = new SqliteNotesRepository(t.db);
  });
  afterEach(() => t.cleanup());

  it('returns null for non-existent id', () => {
    const result = updateNote(99999, { content: 'x' }, { db: t.db, repo });
    expect(result).toBeNull();
  });

  it('updates content + clears content_translated', () => {
    const note = createNote({ content: 'original' }, { db: t.db, repo });
    getRawDatabase(t.db)
      .prepare('UPDATE notes SET content_translated = ? WHERE id = ?')
      .run('translated', note.id);

    const updated = updateNote(note.id, { content: 'new content' }, { db: t.db, repo });
    expect(updated?.content).toBe('new content');
    expect(updated?.contentTranslated).toBeNull();
  });

  it('updates subtype without affecting content', () => {
    const note = createNote({ content: 'x', subtype: 'note' }, { db: t.db, repo });
    const updated = updateNote(note.id, { subtype: 'memo' }, { db: t.db, repo });
    expect(updated?.subtype).toBe('memo');
    expect(updated?.content).toBe('x');
  });

  it('replaces tags (not appends)', () => {
    const note = createNote({ content: 'x', tags: ['foo', 'bar'] }, { db: t.db, repo });
    const updated = updateNote(note.id, { tags: ['baz'] }, { db: t.db, repo });
    expect(updated?.tags).toEqual(['baz']);
  });

  it('replaces linkedEntityIds with soft-validation', () => {
    const now = utcNowMs();
    const [a, b] = t.db
      .insert(entities)
      .values([
        { name: 'A', createdAt: now, updatedAt: now },
        { name: 'B', createdAt: now, updatedAt: now },
      ])
      .returning({ id: entities.id })
      .all();

    const note = createNote({ content: 'x', linkedEntityIds: [a.id] }, { db: t.db, repo });
    const updated = updateNote(note.id, { linkedEntityIds: [b.id, 99999] }, { db: t.db, repo });
    expect(updated?.linkedEntities.map((e) => e.id)).toEqual([b.id]);
  });

  it('toggles pinned + archived', () => {
    const note = createNote({ content: 'x' }, { db: t.db, repo });
    const updated = updateNote(note.id, { pinned: true, archived: true }, { db: t.db, repo });
    expect(updated?.pinned).toBe(true);
    expect(updated?.archived).toBe(true);
  });

  it('empty tags array clears all tags', () => {
    const note = createNote({ content: 'x', tags: ['foo'] }, { db: t.db, repo });
    const updated = updateNote(note.id, { tags: [] }, { db: t.db, repo });
    expect(updated?.tags).toEqual([]);
  });
});

describe('updateNote dueAt + remindedAt invariants (P7.4)', () => {
  let t: TestDB;
  let repo: SqliteNotesRepository;

  beforeEach(() => {
    t = createTestDB();
    repo = new SqliteNotesRepository(t.db);
  });
  afterEach(() => t.cleanup());

  it('sets dueAt and leaves remindedAt null when no prior reminded', () => {
    const note = createNote({ content: 'memo', subtype: 'memo' }, { db: t.db, repo });
    const out = updateNote(note.id, { dueAt: 1_700_000_000_000 }, { db: t.db, repo });
    expect(out?.dueAt).toBe(1_700_000_000_000);
    expect(out?.remindedAt).toBeNull();
  });

  it('clears remindedAt when new dueAt > prior remindedAt', () => {
    const note = createNote({ content: 'memo', subtype: 'memo' }, { db: t.db, repo });
    updateNote(note.id, { dueAt: 1_000 }, { db: t.db, repo });
    repo.markReminded(note.id); // remindedAt = utcNowMs() (large), > 1_000
    const before = repo.get(note.id);
    expect(before?.remindedAt).not.toBeNull();

    const newDue = (before?.remindedAt ?? 0) + 10_000_000;
    const after = updateNote(note.id, { dueAt: newDue }, { db: t.db, repo });
    expect(after?.dueAt).toBe(newDue);
    expect(after?.remindedAt).toBeNull();
  });

  it('preserves remindedAt when new dueAt <= prior remindedAt (user refining)', () => {
    const note = createNote({ content: 'memo', subtype: 'memo' }, { db: t.db, repo });
    updateNote(note.id, { dueAt: 1_000 }, { db: t.db, repo });
    repo.markReminded(note.id);
    const before = repo.get(note.id);
    const remindedAt = before?.remindedAt;
    expect(remindedAt).not.toBeNull();

    const newDue = (remindedAt ?? 0) - 10_000;
    const after = updateNote(note.id, { dueAt: newDue }, { db: t.db, repo });
    expect(after?.dueAt).toBe(newDue);
    expect(after?.remindedAt).toBe(remindedAt);
  });

  it('setting dueAt = null clears remindedAt too (no due ≡ no reminder)', () => {
    const note = createNote({ content: 'memo', subtype: 'memo' }, { db: t.db, repo });
    updateNote(note.id, { dueAt: 1_000 }, { db: t.db, repo });
    repo.markReminded(note.id);

    const out = updateNote(note.id, { dueAt: null }, { db: t.db, repo });
    expect(out?.dueAt).toBeNull();
    expect(out?.remindedAt).toBeNull();
  });
});

describe('NotesRepository.markReminded (P7.4)', () => {
  let t: TestDB;
  let repo: SqliteNotesRepository;

  beforeEach(() => {
    t = createTestDB();
    repo = new SqliteNotesRepository(t.db);
  });
  afterEach(() => t.cleanup());

  it('sets remindedAt + updatedAt to utcNowMs() and returns the new timestamp', () => {
    const note = createNote({ content: 'memo', subtype: 'memo' }, { db: t.db, repo });
    updateNote(note.id, { dueAt: 1_000 }, { db: t.db, repo });
    const before = Date.now();
    const result = repo.markReminded(note.id);
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
    const refreshed = repo.get(note.id);
    expect(refreshed?.remindedAt).toBe(result);
    expect(refreshed?.updatedAt).toBe(result);
  });

  it('throws when note does not exist', () => {
    expect(() => repo.markReminded(99_999)).toThrow();
  });

  // Contract: route layer discriminates 404 via central `getErrorCode` (which
  // reads `.code`). Lock in the code so the route can stop using message regex.
  it('throws error carrying code="note_not_found" for route discrimination', () => {
    let caught: unknown;
    try {
      repo.markReminded(99_999);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: unknown }).code).toBe('note_not_found');
  });

  it('rejects notes without dueAt as not pending', () => {
    const note = createNote({ content: 'memo', subtype: 'memo' }, { db: t.db, repo });
    let caught: unknown;
    try {
      repo.markReminded(note.id);
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: unknown }).code).toBe('note_reminder_not_pending');
    expect((caught as { status?: unknown }).status).toBe(400);
  });

  it('rejects future reminders so stale banner dismiss cannot pre-ack them', () => {
    const note = createNote({ content: 'memo', subtype: 'memo' }, { db: t.db, repo });
    updateNote(note.id, { dueAt: Date.now() + 60_000 }, { db: t.db, repo });
    expect(() => repo.markReminded(note.id)).toThrow();
    expect(repo.get(note.id)?.remindedAt).toBeNull();
  });

  it('rejects when expectedDueAt no longer matches current dueAt', () => {
    const note = createNote({ content: 'memo', subtype: 'memo' }, { db: t.db, repo });
    updateNote(note.id, { dueAt: Date.now() - 60_000 }, { db: t.db, repo });
    let caught: unknown;
    try {
      repo.markReminded(note.id, { expectedDueAt: Date.now() - 120_000 });
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: unknown }).code).toBe('note_reminder_not_pending');
    expect((caught as { status?: unknown }).status).toBe(409);
    expect(repo.get(note.id)?.remindedAt).toBeNull();
  });
});
