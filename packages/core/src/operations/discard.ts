import { eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/connection';
import { getRawDatabase } from '../db/connection';
import type { EventLogRepository, KnowledgeRepository } from '../db/repositories/types';
import { eventLogs, sourceEntityPoints, sources } from '../db/schema';

export interface DiscardSourceDeps {
  db: DrizzleDB;
  repos: {
    knowledge: KnowledgeRepository;
    eventLog: EventLogRepository;
  };
  embeddingEnabled: boolean;
  logger?: { debug: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

export type DiscardSourceResult = { ok: true } | { ok: false; code: 'invalid_status' };

/**
 * Discard a confirmed/confirmed_empty source.
 *
 * Phase 1 (transaction): Update source status, delete SEP records.
 * Phase 2 (post-transaction): Orphan point cleanup + optional vec row cleanup.
 *
 * Post-transaction cleanup failures are logged but do not cause the operation
 * to fail — the source is already marked discarded.
 */
export function discardSource(sourceId: number, deps: DiscardSourceDeps): DiscardSourceResult {
  const { db, repos, embeddingEnabled } = deps;

  // Pre-transaction: gather entity IDs for post-transaction cleanup
  const entityIds = repos.knowledge.getEntityIdsForSource(sourceId);

  let needsCleanup = false;
  try {
    const rawDb = getRawDatabase(db);
    needsCleanup = rawDb
      .transaction(() => {
        const currentSource = db.select().from(sources).where(eq(sources.id, sourceId)).get();
        if (
          !currentSource ||
          (currentSource.status !== 'confirmed' && currentSource.status !== 'confirmed_empty')
        ) {
          throw new Error('DISCARD_INVALID_STATUS');
        }

        db.update(sources).set({ status: 'discarded' }).where(eq(sources.id, sourceId)).run();

        if (currentSource.status === 'confirmed_empty') {
          db.insert(eventLogs)
            .values({
              sourceId,
              action: 'source_discarded',
              summary: 'Confirmed-empty source discarded (no knowledge cleanup needed)',
            })
            .run();
          return false;
        }

        db.delete(sourceEntityPoints).where(eq(sourceEntityPoints.sourceId, sourceId)).run();
        return true;
      })
      .immediate();
  } catch (err) {
    if (err instanceof Error && err.message === 'DISCARD_INVALID_STATUS') {
      return { ok: false, code: 'invalid_status' };
    }
    throw err;
  }

  if (!needsCleanup) return { ok: true };

  // Post-transaction: idempotent orphan cleanup runs outside the transaction.
  // TODO(v2-pg): When migrating to PostgreSQL, move orphan cleanup inside the
  // transaction — concurrent pipeline writes can create new SEP records between
  // findOrphanPoints() and discardPoint(), risking incorrect point discards.
  try {
    const orphanPoints = repos.knowledge.findOrphanPoints();

    const vecDeleteStmt = embeddingEnabled
      ? getRawDatabase(db).prepare('DELETE FROM knowledge_points_vec WHERE rowid = ?')
      : null;
    for (const point of orphanPoints) {
      repos.knowledge.discardPoint(point.id);
      if (vecDeleteStmt) {
        try {
          vecDeleteStmt.run(BigInt(point.id));
        } catch (err) {
          deps.logger?.debug('[discard] Vec cleanup failed for point', point.id, err);
        }
      }
      repos.eventLog.create({
        sourceId,
        pointId: point.id,
        action: 'point_discarded',
        summary: 'Orphan point discarded during source discard',
      });
    }

    let emptiedEntityCount = 0;
    for (const entityId of entityIds) {
      if (!repos.knowledge.entityHasActivePoints(entityId)) {
        emptiedEntityCount++;
      }
    }

    repos.eventLog.create({
      sourceId,
      action: 'source_discarded',
      summary: `Cleanup complete. ${orphanPoints.length} orphan points cleaned, ${entityIds.length} entities checked, ${emptiedEntityCount} now empty.`,
    });
  } catch (err) {
    deps.logger?.error('Post-transaction cleanup failed (source already discarded):', err);
  }

  return { ok: true };
}
