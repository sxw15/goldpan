import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

export interface TestDB {
  db: ReturnType<typeof drizzle>;
  dbPath: string;
  tmpDir: string;
  cleanup: () => void;
}

/**
 * Spin up an in-memory-style SQLite file and apply all core migrations. Same
 * pattern as `packages/im-runtime/tests/helpers/test-db.ts` — duplicated here
 * because that helper lives in the runtime's private `tests/` directory and
 * isn't exported. If a third plugin ever needs it, lift to
 * `@goldpan/im-runtime/testing`.
 */
export function createTestDB(): TestDB {
  const tmpDir = mkdtempSync(join(tmpdir(), 'goldpan-feishu-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const raw = new Database(dbPath);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');

  const migrationsDir = join(import.meta.dirname, '../../../../packages/core/drizzle');
  const journalPath = join(migrationsDir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as {
    entries: Array<{ tag: string }>;
  };

  for (const entry of journal.entries) {
    const sqlPath = join(migrationsDir, `${entry.tag}.sql`);
    const sql = readFileSync(sqlPath, 'utf-8');
    raw.exec(sql);
  }

  const db = drizzle(raw);
  return {
    db,
    dbPath,
    tmpDir,
    cleanup: () => {
      raw.close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
