import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { getRawDatabase } from '../src/db/connection.js';
import { SqliteMetadataRepository } from '../src/db/repositories/metadata.js';
import { createTestDB, type TestDB } from './helpers/test-db.js';

describe('DB Connection & Test Harness', () => {
  let testDB: TestDB | undefined;

  afterEach(() => {
    testDB?.cleanup();
    testDB = undefined;
  });

  it('creates database with WAL mode and foreign keys', () => {
    testDB = createTestDB();
    const raw = getRawDatabase(testDB.db);
    const journalMode = raw.pragma('journal_mode', { simple: true });
    expect(journalMode).toBe('wal');
    const fk = raw.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });

  it('runs migrations and creates all tables', () => {
    testDB = createTestDB();
    const raw = getRawDatabase(testDB.db);
    const tables = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' AND name NOT LIKE '%_fts%' ORDER BY name",
      )
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual([
      'categories',
      'conversation_messages',
      'conversations',
      'db_metadata',
      'entities',
      'entity_categories',
      'entity_relations',
      'event_logs',
      'im_messages_seen',
      'knowledge_points',
      'llm_calls',
      'note_entities',
      'note_sources',
      'note_tags',
      'notes',
      'point_tags',
      'processing_tasks',
      'runtime_config_overrides',
      'source_entity_points',
      'sources',
      'submission_logs',
      'tags',
      'task_logs',
    ]);
  });

  it('cleanup closes db and removes files', () => {
    testDB = createTestDB();
    const tmpDir = testDB.tmpDir;
    testDB.cleanup();
    expect(existsSync(tmpDir)).toBe(false);
    testDB = undefined;
  });

  it('MetadataRepository.delete removes a key', () => {
    testDB = createTestDB();
    const repo = new SqliteMetadataRepository(testDB.db);
    repo.set('foo', 'bar');
    expect(repo.get('foo')).toBe('bar');
    repo.delete('foo');
    expect(repo.get('foo')).toBeUndefined();
    // delete on non-existent key should not throw
    expect(() => repo.delete('nonexistent')).not.toThrow();
  });
});
