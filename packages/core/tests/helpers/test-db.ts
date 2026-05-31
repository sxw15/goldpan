import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type DrizzleDB, getRawDatabase } from '../../src/db/connection.js';
import { ensureFtsTables } from '../../src/db/fts.js';
import { runMigrations } from '../../src/db/migrate.js';

export interface TestDB {
  db: DrizzleDB;
  dbPath: string;
  tmpDir: string;
  cleanup: () => void;
}

export function createTestDB(): TestDB {
  const tmpDir = mkdtempSync(join(tmpdir(), 'goldpan-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const db = createDatabase(dbPath);

  const migrationsFolder = join(import.meta.dirname, '../../drizzle');
  runMigrations(db, migrationsFolder);

  // FTS5 tables are created by bootstrap (not migrations) — replicate here for tests
  const raw = getRawDatabase(db);
  ensureFtsTables(raw, 'en');

  return {
    db,
    dbPath,
    tmpDir,
    cleanup: () => {
      try {
        getRawDatabase(db).close();
      } catch {
        /* already closed */
      }
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
