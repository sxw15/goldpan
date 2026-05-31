import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleDB } from '../db/connection';
import { entities, noteEntities, noteSources, notes, noteTags, sources } from '../db/schema';
import { utcNowMs } from '../db/timestamp';
import type { NoteDetail, NotesRepository, UpdateNoteInput } from './types';

export interface UpdateNoteDeps {
  db: DrizzleDB;
  repo: NotesRepository;
}

/**
 * Apply a patch to a note. Content edits invalidate `content_translated`
 * (re-translation is async, downstream). Tag / entity replacements are
 * full replacements, not appends — pass the desired final set.
 */
export function updateNote(
  id: number,
  patch: UpdateNoteInput,
  deps: UpdateNoteDeps,
): NoteDetail | null {
  return deps.db.transaction((tx) => {
    const existing = tx
      .select({ id: notes.id, remindedAt: notes.remindedAt })
      .from(notes)
      .where(eq(notes.id, id))
      .get();
    if (!existing) return null;

    const noteUpdates: Partial<typeof notes.$inferInsert> = { updatedAt: utcNowMs() };
    if (patch.content !== undefined) {
      noteUpdates.content = patch.content;
      noteUpdates.contentTranslated = null;
    }
    if (patch.subtype !== undefined) noteUpdates.subtype = patch.subtype;
    if (patch.pinned !== undefined) noteUpdates.pinned = patch.pinned;
    if (patch.archived !== undefined) noteUpdates.archived = patch.archived;

    if (patch.dueAt !== undefined) {
      noteUpdates.dueAt = patch.dueAt;
      // D12 conditional clear: clear remindedAt when:
      // - dueAt = null (no due ≡ no reminder)
      // - OR new dueAt > prior remindedAt (user re-set forward)
      // Preserve remindedAt when user refines dueAt backward (precision tweak,
      // already-acknowledged reminder stays acknowledged).
      if (patch.dueAt === null) {
        noteUpdates.remindedAt = null;
      } else {
        const oldReminded = existing.remindedAt ?? 0;
        if (patch.dueAt > oldReminded) noteUpdates.remindedAt = null;
        // else: leave remindedAt alone — don't write it in this update
      }
    }

    tx.update(notes).set(noteUpdates).where(eq(notes.id, id)).run();

    if (patch.tags !== undefined) {
      tx.delete(noteTags).where(eq(noteTags.noteId, id)).run();
      const cleaned = [
        ...new Set(patch.tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)),
      ];
      if (cleaned.length > 0) {
        tx.insert(noteTags)
          .values(cleaned.map((tag) => ({ noteId: id, tag })))
          .run();
      }
    }

    if (patch.linkedEntityIds !== undefined) {
      tx.delete(noteEntities).where(eq(noteEntities.noteId, id)).run();
      if (patch.linkedEntityIds.length > 0) {
        const wanted = [...new Set(patch.linkedEntityIds)];
        const found = tx
          .select({ id: entities.id })
          .from(entities)
          .where(inArray(entities.id, wanted))
          .all();
        const validIds = new Set(found.map((e) => e.id));
        const rows = wanted
          .filter((eid) => validIds.has(eid))
          .map((eid) => ({ noteId: id, entityId: eid }));
        if (rows.length > 0) tx.insert(noteEntities).values(rows).run();
      }
    }

    // B9: 替换 relation='reference' 的 note_sources。derived_from（promote 创建的
    // 溯源链）保持不动，PATCH 无法破坏。软校验：不存在的 source id 静默丢弃。
    if (patch.linkedSourceIds !== undefined) {
      tx.delete(noteSources)
        .where(and(eq(noteSources.noteId, id), eq(noteSources.relation, 'reference')))
        .run();
      if (patch.linkedSourceIds.length > 0) {
        const wanted = [...new Set(patch.linkedSourceIds)];
        const found = tx
          .select({ id: sources.id })
          .from(sources)
          .where(inArray(sources.id, wanted))
          .all();
        const validIds = new Set(found.map((s) => s.id));
        const rows = wanted
          .filter((sid) => validIds.has(sid))
          .map((sid) => ({ noteId: id, sourceId: sid, relation: 'reference' as const }));
        if (rows.length > 0) tx.insert(noteSources).values(rows).run();
      }
    }

    // See `createNote` for the single-connection visibility justification.
    return deps.repo.get(id);
  });
}
