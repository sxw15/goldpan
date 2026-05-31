import { type DrizzleDB, getRawDatabase } from '@goldpan/core/db';
import type { CapturesModule } from '../types.js';
import type { DateRange } from './tracking-findings.js';

interface CaptureRow {
  id: number;
  title: string | null;
  original_url: string | null;
  created_at: number;
}

export function collectCaptures(db: DrizzleDB, range: DateRange, cap: number): CapturesModule {
  const raw = getRawDatabase(db);

  const countRow = raw
    .prepare(
      `SELECT COUNT(*) AS n FROM sources
       WHERE origin = 'user' AND kind = 'external' AND created_at BETWEEN ? AND ?`,
    )
    .get(range.from, range.to) as { n: number };

  const rows = raw
    .prepare(
      `SELECT id, title, original_url, created_at
       FROM sources
       WHERE origin = 'user' AND kind = 'external' AND created_at BETWEEN ? AND ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(range.from, range.to, cap) as CaptureRow[];

  const items = rows.map((r) => ({
    id: r.id,
    title: r.title ?? r.original_url ?? '',
    url: r.original_url ?? '',
    createdAt: r.created_at,
  }));
  const hiddenCount = Math.max(0, countRow.n - items.length);

  return {
    type: 'captures',
    items,
    hasMore: hiddenCount > 0,
    hiddenCount,
  };
}
