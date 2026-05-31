import { type DrizzleDB, getRawDatabase } from '@goldpan/core/db';
import type { NewEntitiesModule } from '../types.js';
import type { DateRange } from './tracking-findings.js';

interface EntityRow {
  id: number;
  name: string;
  description: string | null;
  created_at: number;
}

export function collectNewEntities(
  db: DrizzleDB,
  range: DateRange,
  cap: number,
): NewEntitiesModule {
  const raw = getRawDatabase(db);

  const countRow = raw
    .prepare('SELECT COUNT(*) AS n FROM entities WHERE created_at BETWEEN ? AND ?')
    .get(range.from, range.to) as { n: number };

  const rows = raw
    .prepare(
      `SELECT id, name, description, created_at
       FROM entities
       WHERE created_at BETWEEN ? AND ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(range.from, range.to, cap) as EntityRow[];

  const items = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    createdAt: r.created_at,
  }));
  const hiddenCount = Math.max(0, countRow.n - items.length);

  return {
    type: 'new_entities',
    items,
    hasMore: hiddenCount > 0,
    hiddenCount,
  };
}
