import { type DrizzleDB, getRawDatabase } from '@goldpan/core/db';
import type { StatsModule } from '../types.js';
import type { DateRange } from './tracking-findings.js';

interface SourceCounts {
  captures: number;
  findings: number;
  thoughts: number;
}

interface EntityCount {
  entities: number;
}

export function collectStats(db: DrizzleDB, range: DateRange): StatsModule {
  const raw = getRawDatabase(db);
  const sourceRow = raw
    .prepare(
      `SELECT
         SUM(CASE WHEN origin = 'user' AND kind = 'external' THEN 1 ELSE 0 END) AS captures,
         SUM(CASE WHEN origin = 'tracking' THEN 1 ELSE 0 END) AS findings,
         SUM(CASE WHEN origin = 'user' AND kind = 'user' THEN 1 ELSE 0 END) AS thoughts
       FROM sources
       WHERE created_at BETWEEN ? AND ?`,
    )
    .get(range.from, range.to) as SourceCounts | undefined;
  const entityRow = raw
    .prepare('SELECT COUNT(*) AS entities FROM entities WHERE created_at BETWEEN ? AND ?')
    .get(range.from, range.to) as EntityCount | undefined;
  return {
    type: 'stats',
    captures: sourceRow?.captures ?? 0,
    findings: sourceRow?.findings ?? 0,
    thoughts: sourceRow?.thoughts ?? 0,
    entities: entityRow?.entities ?? 0,
  };
}
