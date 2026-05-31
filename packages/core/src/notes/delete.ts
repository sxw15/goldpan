import { eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/connection';
import { notes } from '../db/schema';

export interface DeleteNoteDeps {
  db: DrizzleDB;
}

/**
 * Hard delete. Associated rows in note_tags / note_entities / note_sources
 * cascade via FK; notes_fts is kept in sync by AFTER DELETE trigger.
 */
export function deleteNote(id: number, deps: DeleteNoteDeps): boolean {
  const result = deps.db.delete(notes).where(eq(notes.id, id)).run();
  return result.changes > 0;
}
