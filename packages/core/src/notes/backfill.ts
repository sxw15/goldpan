import { eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/connection';
import { noteEntities, noteSources, sourceEntityPoints } from '../db/schema';

export interface BackfillResult {
  /** Notes that referenced this source (already had a note_sources row). */
  notesUpdated: number;
  /** Total entity links actually written (existing rows skipped via onConflictDoNothing). */
  entityLinksAdded: number;
}

/**
 * notes domain utility — 给某 source 关联的 notes 补 note_entities 行。
 *
 * 调用方：
 * - deferred/resolver.ts —— pipeline 终态时 deferredResolver 调用补回填
 * - plugins/builtin/intent-note —— A2 race 兜底：plugin 在 createNote 后回查
 *   source 状态，若 confirmed 但当时步骤 2 没反查到 entity，inline 调用补
 *
 * 用 onConflictDoNothing 让 idempotent —— resolver retry / 与 plugin race
 * 都安全。failed/discarded 的 source 不调用（无 entity 可填）—— 上游 guard。
 * 不动 noteSources 表（关系本身不变）。
 */
export function backfillNoteEntitiesForSource(sourceId: number, db: DrizzleDB): BackfillResult {
  const linkedNotes = db
    .select({ noteId: noteSources.noteId })
    .from(noteSources)
    .where(eq(noteSources.sourceId, sourceId))
    .all();

  if (linkedNotes.length === 0) {
    return { notesUpdated: 0, entityLinksAdded: 0 };
  }

  const entityRows = db
    .selectDistinct({ entityId: sourceEntityPoints.entityId })
    .from(sourceEntityPoints)
    .where(eq(sourceEntityPoints.sourceId, sourceId))
    .all();
  const entityIds = entityRows.map((r) => r.entityId);

  if (entityIds.length === 0) {
    return { notesUpdated: linkedNotes.length, entityLinksAdded: 0 };
  }

  // Per-row insert with onConflictDoNothing — `.changes` reflects 1 (inserted)
  // vs 0 (conflict skipped), so we can count actual links added for telemetry /
  // resolver bookkeeping. 与 KnowledgeRepository.linkPointTags 等同手法。
  let linksAdded = 0;
  for (const { noteId } of linkedNotes) {
    for (const entityId of entityIds) {
      const result = db
        .insert(noteEntities)
        .values({ noteId, entityId })
        .onConflictDoNothing({ target: [noteEntities.noteId, noteEntities.entityId] })
        .run();
      if (result.changes > 0) linksAdded++;
    }
  }

  return { notesUpdated: linkedNotes.length, entityLinksAdded: linksAdded };
}
