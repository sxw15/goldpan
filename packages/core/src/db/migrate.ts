import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate as drizzleMigrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolveProjectRoot } from '../config/index';
import { type DrizzleDB, getRawDatabase } from './connection';

export function runMigrations(db: DrizzleDB, migrationsFolder: string): void {
  // drizzle-kit emits `PRAGMA foreign_keys=OFF` at the top of every
  // table-recreate migration, but drizzle-orm's SQLite migrator wraps all
  // pending migrations in a single BEGIN..COMMIT, and SQLite specifies that
  // PRAGMA foreign_keys is a no-op inside a transaction. So we must toggle
  // it on the connection here, before the migrator opens its transaction.
  const sqlite = getRawDatabase(db);
  const fkBefore = sqlite.pragma('foreign_keys', { simple: true }) as 0 | 1;
  sqlite.pragma('foreign_keys = OFF');
  try {
    drizzleMigrate(db, { migrationsFolder });
    const orphans = sqlite.pragma('foreign_key_check') as unknown[];
    if (orphans.length > 0) {
      throw new Error(
        `Migration left ${orphans.length} dangling foreign-key reference(s); refusing to re-enable foreign_keys. First: ${JSON.stringify(orphans[0])}`,
      );
    }
  } finally {
    sqlite.pragma(`foreign_keys = ${fkBefore ? 'ON' : 'OFF'}`);
  }
}

/**
 * Locate the drizzle migrations folder. Resolution order:
 * 1. Explicit path (if provided and valid)
 * 2. Relative to this file's location (works in both src/ and dist/)
 * 3. resolveProjectRoot() + 'packages/core/drizzle'
 */
export function resolveMigrationsFolder(explicitPath?: string): string {
  const journal = (dir: string) => path.join(dir, 'meta', '_journal.json');

  if (explicitPath && fs.existsSync(journal(explicitPath))) {
    return explicitPath;
  }

  // Relative to this file: src/db/migrate.ts → ../../drizzle or dist/db/migrate.mjs → ../../drizzle
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const fromFile = path.resolve(thisDir, '../../drizzle');
  if (fs.existsSync(journal(fromFile))) return fromFile;

  // Fallback: monorepo root / packages/core/drizzle
  const fromRoot = path.join(resolveProjectRoot(), 'packages', 'core', 'drizzle');
  if (fs.existsSync(journal(fromRoot))) return fromRoot;

  throw new Error(
    `Cannot find drizzle migrations. Searched: ${[explicitPath, fromFile, fromRoot].filter(Boolean).join(', ')}`,
  );
}
