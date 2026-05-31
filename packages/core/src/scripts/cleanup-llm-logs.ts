/**
 * LLM Log Cleanup Script
 *
 * Deletes llm_calls records older than a specified time.
 * Usage: npx tsx packages/core/src/scripts/cleanup-llm-logs.ts --before <date>
 *
 * Examples:
 *   npx tsx packages/core/src/scripts/cleanup-llm-logs.ts --before 2025-01-01
 *   npx tsx packages/core/src/scripts/cleanup-llm-logs.ts --before 30d
 *   npx tsx packages/core/src/scripts/cleanup-llm-logs.ts --before 2025-06-15T00:00:00Z
 *
 * The --before argument accepts:
 *   - ISO 8601 date string (e.g., "2025-01-01", "2025-06-15T10:30:00Z")
 *   - Relative duration: "<number>d" for days (e.g., "30d" = 30 days ago)
 *
 * Dry run (default): shows count of records that would be deleted.
 * Use --execute to actually delete records.
 *
 * Note: This deletes entire rows, including token count fields.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveProjectRoot } from '../config/index';
import { closeDatabase, createDatabase, getRawDatabase } from '../db/connection';

function parseBeforeDate(value: string): Date {
  // Relative duration: "30d" → 30 days ago
  const relativeMatch = value.match(/^(\d+)d$/);
  if (relativeMatch) {
    const days = Number.parseInt(relativeMatch[1], 10);
    if (days === 0) {
      throw new Error('--before 0d would delete ALL records. Use --before 1d or greater.');
    }
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date;
  }

  // ISO date string
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `Invalid date format: "${value}". Use ISO 8601 (e.g., "2025-01-01") or relative (e.g., "30d").`,
    );
  }
  return date;
}

async function main() {
  const { values } = parseArgs({
    options: {
      before: { type: 'string' },
      execute: { type: 'boolean', default: false },
      dbPath: { type: 'string' },
    },
    strict: true,
  });

  if (!values.before) {
    console.error('Error: --before is required.');
    console.error('Usage: npx tsx packages/core/src/scripts/cleanup-llm-logs.ts --before <date>');
    console.error('Examples: --before 2025-01-01, --before 30d');
    process.exit(1);
  }

  const beforeDate = parseBeforeDate(values.before);
  // llm_calls.timestamp 是 INTEGER epoch ms 列：直接传 number。
  // 传字符串会触发 SQLite type affinity（INTEGER 总 < TEXT），导致 WHERE timestamp < '...' 命中全表。
  const beforeMs = beforeDate.getTime();
  const beforeLabel = beforeDate.toISOString();

  console.log(`Cleanup target: llm_calls records before ${beforeLabel}`);

  const raw = values.dbPath ?? process.env.GOLDPAN_DB_SQLITE_PATH ?? './data/goldpan.db';
  const dbPath = path.isAbsolute(raw) ? raw : path.resolve(resolveProjectRoot(), raw);
  if (!fs.existsSync(dbPath)) {
    console.error(`Error: Database file not found: ${dbPath}`);
    console.error('Use --dbPath to specify the correct path, or set GOLDPAN_DB_SQLITE_PATH.');
    process.exit(1);
  }
  const db = createDatabase(dbPath);
  const rawDb = getRawDatabase(db);

  try {
    // Count records to be deleted
    const countResult = rawDb
      .prepare('SELECT COUNT(*) as count FROM llm_calls WHERE timestamp < ?')
      .get(beforeMs) as { count: number };

    console.log(`Found ${countResult.count} records to delete.`);

    if (countResult.count === 0) {
      console.log('Nothing to clean up.');
      return;
    }

    if (!values.execute) {
      console.log('\nDry run — no records deleted.');
      console.log('Add --execute to actually delete records.');
      return;
    }

    // Execute deletion
    const deleteResult = rawDb.prepare('DELETE FROM llm_calls WHERE timestamp < ?').run(beforeMs);

    console.log(`Deleted ${deleteResult.changes} records.`);
  } finally {
    closeDatabase(db);
  }
}

main().catch((err) => {
  console.error('Cleanup failed:', err.message);
  process.exit(1);
});
