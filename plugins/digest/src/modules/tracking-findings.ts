import { type DrizzleDB, getRawDatabase } from '@goldpan/core/db';
import type { TrackingFindingsModule } from '../types.js';

/**
 * Closed inclusive window in ms since epoch: `from ≤ ts ≤ to`.
 *
 * Producers (engine / scheduler / tests) pass the day boundary as
 * `[YYYY-MM-DDT00:00:00.000Z, YYYY-MM-DDT23:59:59.999Z]`, and module SQL
 * uses `BETWEEN` which is also inclusive on both ends.
 */
export interface DateRange {
  from: number;
  to: number;
}

interface FindingRow {
  id: number;
  tracking_rule_id: number | null;
  title: string | null;
  original_url: string | null;
  created_at: number;
}

export function collectTrackingFindings(
  db: DrizzleDB,
  range: DateRange,
  cap: number,
): TrackingFindingsModule {
  const raw = getRawDatabase(db);

  const countRow = raw
    .prepare(
      `SELECT COUNT(*) AS n FROM sources
       WHERE origin = 'tracking' AND created_at BETWEEN ? AND ?`,
    )
    .get(range.from, range.to) as { n: number };

  const rows = raw
    .prepare(
      `SELECT id, tracking_rule_id, title, original_url, created_at
       FROM sources
       WHERE origin = 'tracking' AND created_at BETWEEN ? AND ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(range.from, range.to, cap) as FindingRow[];

  const items = rows.map((r) => ({
    id: r.id,
    // Pass through NULL: there is no DB constraint enforcing
    // `origin='tracking' ⇒ tracking_rule_id IS NOT NULL`, and coercing
    // NULL to a sentinel (previously `?? 0`) surfaced as `rule #0` in
    // the rendered digest.
    ruleId: r.tracking_rule_id,
    title: r.title ?? r.original_url ?? '',
    url: r.original_url ?? '',
    createdAt: r.created_at,
  }));
  const hiddenCount = Math.max(0, countRow.n - items.length);

  return {
    type: 'tracking_findings',
    items,
    hasMore: hiddenCount > 0,
    hiddenCount,
  };
}
