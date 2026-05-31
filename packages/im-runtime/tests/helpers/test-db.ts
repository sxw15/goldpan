import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type DrizzleDB, getRawDatabase } from '@goldpan/core/db';
import { runMigrations } from '@goldpan/core/db/migrate';

export interface TestDB {
  db: DrizzleDB;
  dbPath: string;
  tmpDir: string;
  cleanup: () => void;
}

export function createTestDB(): TestDB {
  const tmpDir = mkdtempSync(join(tmpdir(), 'goldpan-im-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const db = createDatabase(dbPath);

  const migrationsFolder = join(import.meta.dirname, '../../../../packages/core/drizzle');
  runMigrations(db, migrationsFolder);

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
