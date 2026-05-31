import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRawDatabase } from '../../src/db/connection';
import { SqliteNotesRepository } from '../../src/db/repositories/notes.repository';
import { createNote } from '../../src/notes/create';
import { deleteNote } from '../../src/notes/delete';
import { createTestDB, type TestDB } from '../helpers/test-db';

describe('deleteNote', () => {
  let t: TestDB;
  let repo: SqliteNotesRepository;

  beforeEach(() => {
    t = createTestDB();
    repo = new SqliteNotesRepository(t.db);
  });
  afterEach(() => t.cleanup());

  it('returns false for non-existent id', () => {
    expect(deleteNote(99999, { db: t.db })).toBe(false);
  });

  it('deletes a note and returns true; CASCADE wipes note_tags', () => {
    const note = createNote({ content: 'x', tags: ['foo', 'bar'] }, { db: t.db, repo });

    expect(deleteNote(note.id, { db: t.db })).toBe(true);
    expect(repo.get(note.id)).toBeNull();

    const tagRows = getRawDatabase(t.db)
      .prepare('SELECT * FROM note_tags WHERE note_id = ?')
      .all(note.id);
    expect(tagRows).toHaveLength(0);
  });

  it('removes from notes_fts via AFTER DELETE trigger', () => {
    const note = createNote({ content: 'soon to be deleted phrase' }, { db: t.db, repo });
    const raw = getRawDatabase(t.db);
    const before = raw.prepare(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'deleted'`).all();
    expect(before).toHaveLength(1);

    deleteNote(note.id, { db: t.db });

    const after = raw.prepare(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'deleted'`).all();
    expect(after).toHaveLength(0);
  });
});
