import { type DrizzleDB, getRawDatabase } from '@goldpan/core/db';
import { createTestDB } from '../../../../packages/core/tests/helpers/test-db';

export interface SeedOptions {
  dateISO: string;
  captures?: number;
  findings?: number;
  thoughts?: number;
  entities?: number;
}

/**
 * Seed the digest Phase-1 input tables using the real goldpan schema.
 *
 * Mapping (see plugins/digest/src/modules/*):
 *   - captures          = sources WHERE origin='user'     AND kind='external'
 *   - tracking_findings = sources WHERE origin='tracking'                     (no `kind` predicate; matches the actual `tracking-findings.ts` + `stats.ts` queries)
 *   - thoughts          = sources WHERE origin='user'     AND kind='user'     (raw_content)
 *   - new_entities      = entities (created_at in range)
 *
 * `created_at` is stored as INTEGER epoch milliseconds — matches production rows.
 */
export function seedDigestFixture(db: DrizzleDB, opts: SeedOptions): void {
  const raw = getRawDatabase(db);
  const dayStart = new Date(`${opts.dateISO}T00:00:00.000Z`).getTime();

  function at(i: number): number {
    return dayStart + i * 1000;
  }

  const insCapture = raw.prepare(
    `INSERT INTO sources (kind, normalized_url, original_url, title, status, origin, created_at)
     VALUES ('external', ?, ?, ?, 'confirmed', 'user', ?)`,
  );
  for (let i = 0; i < (opts.captures ?? 0); i++) {
    const url = `https://example.com/c/${i}`;
    insCapture.run(url, url, `capture-${i}`, at(i));
  }

  const insFinding = raw.prepare(
    `INSERT INTO sources (kind, normalized_url, original_url, title, status, origin, tracking_rule_id, created_at)
     VALUES ('external', ?, ?, ?, 'confirmed', 'tracking', ?, ?)`,
  );
  for (let i = 0; i < (opts.findings ?? 0); i++) {
    const url = `https://example.com/f/${i}`;
    insFinding.run(url, url, `finding-${i}`, 1, at(i));
  }

  const insThought = raw.prepare(
    `INSERT INTO sources (kind, raw_content, status, origin, created_at)
     VALUES ('user', ?, 'confirmed', 'user', ?)`,
  );
  for (let i = 0; i < (opts.thoughts ?? 0); i++) {
    insThought.run(`thought-${i}`, at(i));
  }

  const insEntity = raw.prepare(
    `INSERT INTO entities (name, description, created_at) VALUES (?, ?, ?)`,
  );
  for (let i = 0; i < (opts.entities ?? 0); i++) {
    insEntity.run(`entity-${i}`, `desc-${i}`, at(i));
  }
}

/**
 * Thin wrapper over createTestDB() — core already sets up db_metadata +
 * migrations + FTS; we just expose { db, cleanup } for digest tests.
 */
export function makeTestDbWithMetadata(): {
  db: DrizzleDB;
  cleanup: () => void;
} {
  const { db, cleanup } = createTestDB();
  return { db, cleanup };
}
