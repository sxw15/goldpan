import type Database from 'better-sqlite3';
import type { DrizzleDB } from '../../db/connection';
import type { EmbeddingProvider } from '../../embedding/types';
import type { IndexedPoint } from '../types';

export const PREFILTER_ENTITY_THRESHOLD = 30;
export const PREFILTER_TOP_K = 5;

export interface PrefilterResult {
  candidateEntityIds: Set<number>;
  embeddingsCache: Map<string, number[]>;
}

export async function prefilterEntities(
  points: IndexedPoint[],
  embeddingProvider: EmbeddingProvider,
  rawDb: Database.Database,
): Promise<PrefilterResult> {
  const texts = points.map((p) => p.content);
  const embeddings = await embeddingProvider.embedMany(texts);

  const candidateEntityIds = new Set<number>();
  const embeddingsCache = new Map<string, number[]>();

  const stmt = rawDb.prepare(
    'SELECT rowid FROM entities_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?',
  );

  for (let i = 0; i < points.length; i++) {
    embeddingsCache.set(points[i].pointKey, embeddings[i]);
    const rows = stmt.all(new Float32Array(embeddings[i]), PREFILTER_TOP_K) as Array<{
      rowid: number;
    }>;
    for (const row of rows) {
      candidateEntityIds.add(row.rowid);
    }
  }

  return { candidateEntityIds, embeddingsCache };
}

export function shouldPrefilter(
  embeddingProvider: EmbeddingProvider | null | undefined,
  db: DrizzleDB | undefined,
  entityCount: number,
): boolean {
  return embeddingProvider != null && db != null && entityCount > PREFILTER_ENTITY_THRESHOLD;
}
