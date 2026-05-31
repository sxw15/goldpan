import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { and, eq, ne } from 'drizzle-orm';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export { and, eq, ne };

export type DrizzleDB = BetterSQLite3Database<typeof schema>;

const rawDbMap = new WeakMap<DrizzleDB, Database.Database>();

export function createDatabase(dbPath: string): DrizzleDB {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  rawDbMap.set(db, sqlite);
  return db;
}

export function getRawDatabase(db: DrizzleDB): Database.Database {
  const raw = rawDbMap.get(db);
  if (!raw) {
    throw new Error('No raw database found — was this DrizzleDB created via createDatabase()?');
  }
  return raw;
}

export function closeDatabase(db: DrizzleDB): void {
  const raw = rawDbMap.get(db);
  if (raw) {
    try {
      raw.close();
    } finally {
      rawDbMap.delete(db);
    }
  }
}
