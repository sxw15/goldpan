import { and, desc, eq } from 'drizzle-orm';
import { type DrizzleDB, getRawDatabase } from '../db/connection';
import type { SubmissionLogRepository } from '../db/repositories/types';
import { noteSources, processingTasks, sources } from '../db/schema';
import { utcNowMs } from '../db/timestamp';
import type { SubmitDeps } from '../submit';
import { type NotesRepository, PROMOTE_NOTE_MIN_CONTENT_LENGTH } from './types';

const PROMOTED_SOURCE_TITLE_MAX = 80;

export interface PromoteNoteDeps {
  notesRepo: NotesRepository;
  db: DrizzleDB;
  submitDeps: Omit<SubmitDeps, 'origin' | 'inputMode'>;
}

export interface PromoteNoteResult {
  taskId: number;
  sourceId: number;
}

export type PromoteNoteErrorCode =
  | 'note_not_found'
  | 'note_archived'
  | 'note_empty'
  | 'note_too_short'
  | 'note_too_long'
  | 'submit_failed';

export class PromoteNoteError extends Error {
  constructor(
    public code: PromoteNoteErrorCode,
    public reason: string,
  ) {
    super(reason);
    this.name = 'PromoteNoteError';
  }
}

/**
 * Promote a user-note to a source by enqueueing a pipeline task on its
 * content. Worker drives execution asynchronously — this function returns
 * as soon as the source + processing_tasks rows are inserted; the resulting
 * source.status starts at 'processing'. Caller polls /tasks/:id or
 * /sources/:id to learn when pipeline finishes. Original note is preserved
 * and linked via note_sources(noteId, sourceId, relation='derived_from').
 *
 * Idempotency: if this note already has a derived_from source, return the
 * existing source/task instead of enqueuing another pipeline run.
 */
export async function promoteNoteToSource(
  noteId: number,
  deps: PromoteNoteDeps,
): Promise<PromoteNoteResult> {
  const note = deps.notesRepo.get(noteId);
  if (!note) {
    throw new PromoteNoteError('note_not_found', `Note ${noteId} not found`);
  }
  if (note.archived) {
    throw new PromoteNoteError('note_archived', `Note ${noteId} is archived`);
  }
  if (!note.content.trim()) {
    throw new PromoteNoteError('note_empty', `Note ${noteId} has empty content`);
  }
  const trimmed = note.content.trim();
  if (trimmed.length < PROMOTE_NOTE_MIN_CONTENT_LENGTH) {
    throw new PromoteNoteError(
      'note_too_short',
      `Note ${noteId} is too short to promote ` +
        `(min ${PROMOTE_NOTE_MIN_CONTENT_LENGTH} chars, got ${trimmed.length})`,
    );
  }
  if (note.content.length > deps.submitDeps.maxTextInputLength) {
    throw new PromoteNoteError(
      'note_too_long',
      `Note ${noteId} exceeds ${deps.submitDeps.maxTextInputLength} chars`,
    );
  }

  const rawDb = getRawDatabase(deps.db);
  const result = rawDb
    .transaction(() => {
      const existing = getExistingPromotion(noteId, deps.db);
      if (existing) return existing;

      const now = utcNowMs();
      const [source] = deps.db
        .insert(sources)
        .values({
          kind: 'user',
          rawContent: note.content,
          title: makePromotedSourceTitle(trimmed),
          normalizedUrl: null,
          originalUrl: null,
          status: 'processing',
          origin: 'user',
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all();

      const [task] = deps.db
        .insert(processingTasks)
        .values({
          sourceId: source.id,
          type: 'pipeline',
          status: 'pending',
          inputType: 'text',
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all();

      deps.db
        .insert(noteSources)
        .values({
          noteId,
          sourceId: source.id,
          relation: 'derived_from',
        })
        .run();

      safeLog(deps.submitDeps.submissionLog, {
        rawInput: note.content,
        result: 'accepted',
        taskId: task.id,
        sourceId: source.id,
      });

      return { taskId: task.id, sourceId: source.id };
    })
    .immediate();

  return result;
}

function getExistingPromotion(noteId: number, db: DrizzleDB): PromoteNoteResult | null {
  const row = db
    .select({
      sourceId: noteSources.sourceId,
      taskId: processingTasks.id,
    })
    .from(noteSources)
    .innerJoin(processingTasks, eq(processingTasks.sourceId, noteSources.sourceId))
    .where(and(eq(noteSources.noteId, noteId), eq(noteSources.relation, 'derived_from')))
    .orderBy(desc(noteSources.sourceId), desc(processingTasks.id))
    .get();
  return row ? { sourceId: row.sourceId, taskId: row.taskId } : null;
}

function makePromotedSourceTitle(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= PROMOTED_SOURCE_TITLE_MAX) return normalized;
  return `${normalized.slice(0, PROMOTED_SOURCE_TITLE_MAX - 3)}...`;
}

function safeLog(
  log: SubmissionLogRepository | undefined,
  data: Parameters<SubmissionLogRepository['create']>[0],
): void {
  try {
    log?.create(data);
  } catch {
    // Audit log failure must not mask the primary result.
  }
}
