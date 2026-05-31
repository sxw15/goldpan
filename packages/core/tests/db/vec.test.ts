import { load as loadSqliteVec } from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRawDatabase } from '../../src/db/connection';
import { ensureVecTables } from '../../src/db/vec';
import { createTestDB, type TestDB } from '../helpers/test-db';

describe('ensureVecTables', () => {
  let testDB: TestDB;

  beforeEach(() => {
    testDB = createTestDB();
    const raw = getRawDatabase(testDB.db);
    loadSqliteVec(raw);
  });

  afterEach(() => {
    testDB.cleanup();
  });

  it('creates vec0 tables on first run', () => {
    const raw = getRawDatabase(testDB.db);
    ensureVecTables(raw, 'openai:text-embedding-3-small', 384);

    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_vec'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('entities_vec');
    expect(names).toContain('knowledge_points_vec');
  });

  it('is idempotent (no-op on second run with same model/dimensions)', () => {
    const raw = getRawDatabase(testDB.db);
    ensureVecTables(raw, 'openai:text-embedding-3-small', 384);
    ensureVecTables(raw, 'openai:text-embedding-3-small', 384);

    const meta = raw
      .prepare("SELECT value FROM db_metadata WHERE key = 'embedding_dimensions'")
      .get() as { value: string } | undefined;
    expect(meta?.value).toBe('384');
  });

  it('recreates tables when model changes', () => {
    const raw = getRawDatabase(testDB.db);
    ensureVecTables(raw, 'openai:text-embedding-3-small', 4);

    const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    raw
      .prepare('INSERT INTO entities_vec(rowid, embedding) VALUES (?, ?)')
      .run(BigInt(1), embedding);

    ensureVecTables(raw, 'openai:text-embedding-3-large', 4);

    const count = raw.prepare('SELECT count(*) as c FROM entities_vec').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('recreates tables when dimensions change', () => {
    const raw = getRawDatabase(testDB.db);
    ensureVecTables(raw, 'openai:text-embedding-3-small', 384);
    ensureVecTables(raw, 'openai:text-embedding-3-small', 256);

    const meta = raw
      .prepare("SELECT value FROM db_metadata WHERE key = 'embedding_dimensions'")
      .get() as { value: string } | undefined;
    expect(meta?.value).toBe('256');
  });
});
