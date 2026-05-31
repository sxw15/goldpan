import { eq, inArray } from 'drizzle-orm';
import type { DrizzleDB } from '../db/connection';
import { entities, noteEntities, noteSources, notes, noteTags, sources } from '../db/schema';
import { utcNowMs } from '../db/timestamp';
import type { CreateNoteInput, NoteDetail, NotesRepository } from './types';

export interface CreateNoteDeps {
  db: DrizzleDB;
  repo: NotesRepository;
}

/**
 * Insert a user note plus its tag / entity / source associations in a single
 * transaction. Linked entities and source are soft-validated (non-existent IDs
 * are silently dropped) so a hallucinating LLM cannot poison the DB; the
 * caller decides whether the silently-narrower result is acceptable.
 */
export function createNote(input: CreateNoteInput, deps: CreateNoteDeps): NoteDetail {
  const now = utcNowMs();

  return deps.db.transaction((tx) => {
    const inserted = tx
      .insert(notes)
      .values({
        content: input.content,
        subtype: input.subtype ?? 'note',
        language: input.language ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: notes.id })
      .get();
    const noteId = inserted.id;

    if (input.tags?.length) {
      const cleaned = [
        ...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)),
      ];
      if (cleaned.length > 0) {
        tx.insert(noteTags)
          .values(cleaned.map((tag) => ({ noteId, tag })))
          .run();
      }
    }

    if (input.linkedEntityIds?.length) {
      const wanted = [...new Set(input.linkedEntityIds)];
      const existing = tx
        .select({ id: entities.id })
        .from(entities)
        .where(inArray(entities.id, wanted))
        .all();
      const validIds = new Set(existing.map((e) => e.id));
      const rows = wanted.filter((id) => validIds.has(id)).map((id) => ({ noteId, entityId: id }));
      if (rows.length > 0) {
        tx.insert(noteEntities).values(rows).run();
      }
    }

    if (input.linkedSourceId !== undefined) {
      const src = tx
        .select({ id: sources.id })
        .from(sources)
        .where(eq(sources.id, input.linkedSourceId))
        .get();
      if (src) {
        tx.insert(noteSources)
          .values({ noteId, sourceId: input.linkedSourceId, relation: 'reference' })
          .run();
      }
    }

    // `repo.get` uses `this.db`, not `tx`. With better-sqlite3 + drizzle's
    // single-connection mode (project default), writes inside an open
    // transaction are immediately visible on the same connection, so reading
    // here is safe. If we ever switch to a connection pool / read replica,
    // this should become `loadDetailFromTx(tx, noteId)`.
    const detail = deps.repo.get(noteId);
    if (!detail) {
      throw new Error(`createNote: failed to load just-created note id=${noteId}`);
    }
    return detail;
  });
}
