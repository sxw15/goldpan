import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRawDatabase } from '../../src/db/connection';
import { createTestDB, type TestDB } from '../helpers/test-db';

describe('notes_fts (P1)', () => {
  let t: TestDB;

  beforeEach(() => {
    t = createTestDB();
  });
  afterEach(() => t.cleanup());

  it('notes_fts virtual table exists after createTestDB (auto ensureFtsTables)', () => {
    const raw = getRawDatabase(t.db);
    const row = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='notes_fts'`)
      .get();
    expect(row).toBeDefined();
  });

  it('inserts into notes_fts on INSERT notes (archived=0)', () => {
    const raw = getRawDatabase(t.db);
    raw.exec(`INSERT INTO notes (content, archived) VALUES ('hello world TypeScript', 0)`);
    const rows = raw
      .prepare(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'TypeScript'`)
      .all();
    expect(rows).toHaveLength(1);
  });

  it('skips notes_fts on INSERT notes (archived=1)', () => {
    const raw = getRawDatabase(t.db);
    raw.exec(`INSERT INTO notes (content, archived) VALUES ('archived only', 1)`);
    const rows = raw.prepare(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'archived'`).all();
    expect(rows).toHaveLength(0);
  });

  it('updates notes_fts on UPDATE notes content', () => {
    const raw = getRawDatabase(t.db);
    raw.exec(`INSERT INTO notes (content, archived) VALUES ('original text', 0)`);
    raw.exec(`UPDATE notes SET content = 'replacement text' WHERE content = 'original text'`);

    const oldRows = raw
      .prepare(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'original'`)
      .all();
    const newRows = raw
      .prepare(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'replacement'`)
      .all();
    expect(oldRows).toHaveLength(0);
    expect(newRows).toHaveLength(1);
  });

  it('removes from notes_fts on DELETE notes', () => {
    const raw = getRawDatabase(t.db);
    raw.exec(`INSERT INTO notes (content, archived) VALUES ('soon gone', 0)`);
    raw.exec(`DELETE FROM notes WHERE content = 'soon gone'`);

    const rows = raw.prepare(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'gone'`).all();
    expect(rows).toHaveLength(0);
  });

  it('indexes content_translated alongside content (bilingual MATCH works)', () => {
    const raw = getRawDatabase(t.db);
    raw.exec(
      `INSERT INTO notes (content, content_translated, archived) VALUES ('原文 keyword', 'TranslationKeyword', 0)`,
    );
    const a = raw.prepare(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'keyword'`).all();
    const b = raw
      .prepare(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'TranslationKeyword'`)
      .all();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  // A7 修复：UPDATE 时 archived 0↔1 toggle 必须正确同步 FTS 行
  it('removes from notes_fts when archived flips 0→1', () => {
    const raw = getRawDatabase(t.db);
    raw.exec(`INSERT INTO notes (content, archived) VALUES ('togglable text', 0)`);
    expect(
      raw.prepare(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'togglable'`).all(),
    ).toHaveLength(1);

    raw.exec(`UPDATE notes SET archived = 1 WHERE content = 'togglable text'`);
    expect(
      raw.prepare(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'togglable'`).all(),
    ).toHaveLength(0);
  });

  it('inserts into notes_fts when archived flips 1→0', () => {
    const raw = getRawDatabase(t.db);
    raw.exec(`INSERT INTO notes (content, archived) VALUES ('restored text', 1)`);
    expect(
      raw.prepare(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'restored'`).all(),
    ).toHaveLength(0);

    raw.exec(`UPDATE notes SET archived = 0 WHERE content = 'restored text'`);
    expect(
      raw.prepare(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'restored'`).all(),
    ).toHaveLength(1);
  });

  it('keeps FTS consistent when content + archived update together', () => {
    const raw = getRawDatabase(t.db);
    raw.exec(`INSERT INTO notes (content, archived) VALUES ('initial body', 0)`);
    raw.exec(
      `UPDATE notes SET content = 'final body', archived = 1 WHERE content = 'initial body'`,
    );
    expect(
      raw.prepare(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'initial'`).all(),
    ).toHaveLength(0);
    expect(
      raw.prepare(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'final'`).all(),
    ).toHaveLength(0);
  });
});
