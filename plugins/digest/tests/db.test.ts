import { getRawDatabase } from '@goldpan/core/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDB } from '../../../packages/core/tests/helpers/test-db';
import { ensureDigestTables } from '../src/db';

describe('ensureDigestTables', () => {
  let db: ReturnType<typeof createTestDB>['db'];
  let cleanup: () => void;

  beforeEach(() => {
    const testDb = createTestDB();
    db = testDb.db;
    cleanup = testDb.cleanup;
  });
  afterEach(() => cleanup());

  it('creates 3 tables and is idempotent', () => {
    ensureDigestTables(db);
    ensureDigestTables(db);
    const raw = getRawDatabase(db);
    const tables = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('daily_reports','digest_presets','digest_subscriptions')",
      )
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    expect(tables).toEqual(['daily_reports', 'digest_presets', 'digest_subscriptions']);
  });

  it('enforces partial unique index on digest_presets(channel) WHERE is_default=1', () => {
    ensureDigestTables(db);
    const raw = getRawDatabase(db);
    const insert = raw.prepare(
      `INSERT INTO digest_presets (channel, name, period, slots_json, is_default, created_at, updated_at)
       VALUES (?, ?, 'daily', '[]', 1, 0, 0)`,
    );
    insert.run('telegram', 'a');
    expect(() => insert.run('telegram', 'b')).toThrow(/UNIQUE/);
  });

  it('CHECK(period<>"weekly" OR push_day IS NOT NULL)', () => {
    ensureDigestTables(db);
    const raw = getRawDatabase(db);
    const insert = raw.prepare(
      `INSERT INTO digest_presets (channel, name, period, slots_json, created_at, updated_at)
       VALUES (?, ?, 'weekly', '[]', 0, 0)`,
    );
    expect(() => insert.run('telegram', 'weekly')).toThrow(/CHECK/);
  });
});
