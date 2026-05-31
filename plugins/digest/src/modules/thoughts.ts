import { type DrizzleDB, getRawDatabase } from '@goldpan/core/db';
import type { ThoughtsModule } from '../types.js';
import type { DateRange } from './tracking-findings.js';

interface ThoughtRow {
  id: number;
  raw_content: string | null;
  created_at: number;
}

export function collectThoughts(db: DrizzleDB, range: DateRange, cap: number): ThoughtsModule {
  const raw = getRawDatabase(db);

  const countRow = raw
    .prepare(
      `SELECT COUNT(*) AS n FROM sources
       WHERE origin = 'user' AND kind = 'user' AND created_at BETWEEN ? AND ?`,
    )
    .get(range.from, range.to) as { n: number };

  const rows = raw
    .prepare(
      `SELECT id, raw_content, created_at
       FROM sources
       WHERE origin = 'user' AND kind = 'user' AND created_at BETWEEN ? AND ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(range.from, range.to, cap) as ThoughtRow[];

  const items = rows.map((r) => ({
    id: r.id,
    text: r.raw_content ?? '',
    createdAt: r.created_at,
  }));
  const hiddenCount = Math.max(0, countRow.n - items.length);

  return {
    type: 'thoughts',
    items,
    hasMore: hiddenCount > 0,
    hiddenCount,
  };
}
