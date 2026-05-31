import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../db/connection';
import { noteEntities, noteSources, notes, noteTags } from '../db/schema';
import type { ListNotesParams, ListNotesResult, NoteDetail, NotesRepository } from './types';

export interface ListNotesDeps {
  db: DrizzleDB;
  repo: NotesRepository;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const CURSOR_RE = /^(\d+):(\d+)$/;

interface ParsedCursor {
  createdAt: number;
  id?: number;
}

export function listNotes(params: ListNotesParams, deps: ListNotesDeps): ListNotesResult {
  const limit = Math.min(MAX_LIMIT, params.limit ?? DEFAULT_LIMIT);

  if (params.search !== undefined && params.search.trim().length > 0) {
    return searchPath(params, limit, deps);
  }
  return normalPath(params, limit, deps);
}

function normalPath(params: ListNotesParams, limit: number, deps: ListNotesDeps): ListNotesResult {
  const { db, repo } = deps;
  const conditions = [];
  const pendingReminderQuery = params.hasReminder === true;

  if (params.subtype !== undefined) {
    const subtypes = Array.isArray(params.subtype) ? params.subtype : [params.subtype];
    conditions.push(inArray(notes.subtype, subtypes));
  }
  if (params.pinned !== undefined) conditions.push(eq(notes.pinned, params.pinned));
  if (params.archived !== undefined) {
    conditions.push(eq(notes.archived, params.archived));
  } else {
    conditions.push(eq(notes.archived, false));
  }
  if (params.dueBefore !== undefined) {
    conditions.push(lte(notes.dueAt, params.dueBefore));
  }
  if (pendingReminderQuery) {
    conditions.push(isNotNull(notes.dueAt));
    conditions.push(isNull(notes.remindedAt));
  }
  const cursor = parseCursor(params.cursor);
  if (cursor) {
    conditions.push(
      cursor.id === undefined
        ? lt(notes.createdAt, cursor.createdAt)
        : or(
            lt(notes.createdAt, cursor.createdAt),
            and(eq(notes.createdAt, cursor.createdAt), lt(notes.id, cursor.id)),
          ),
    );
  }

  let query = db.select({ id: notes.id, createdAt: notes.createdAt }).from(notes).$dynamic();

  if (params.tag !== undefined) {
    query = query.innerJoin(noteTags, eq(noteTags.noteId, notes.id));
    conditions.push(eq(noteTags.tag, params.tag.trim().toLowerCase()));
  }
  if (params.entityId !== undefined) {
    query = query.innerJoin(noteEntities, eq(noteEntities.noteId, notes.id));
    conditions.push(eq(noteEntities.entityId, params.entityId));
  }
  if (params.sourceId !== undefined) {
    query = query.innerJoin(noteSources, eq(noteSources.noteId, notes.id));
    conditions.push(eq(noteSources.sourceId, params.sourceId));
  }

  if (conditions.length > 0) query = query.where(and(...conditions));

  const orderedQuery = pendingReminderQuery
    ? query.orderBy(asc(notes.dueAt), desc(notes.id))
    : query.orderBy(desc(notes.createdAt), desc(notes.id));
  const rows = orderedQuery.limit(limit + 1).all();

  const hasMore = rows.length > limit;
  const sliced = rows.slice(0, limit);
  const data = sliced.map((r) => repo.get(r.id)).filter((n): n is NoteDetail => n !== null);
  const nextCursor =
    !pendingReminderQuery && hasMore && sliced.length > 0
      ? formatCursor(sliced[sliced.length - 1].createdAt, sliced[sliced.length - 1].id)
      : null;

  return { data, nextCursor };
}

function searchPath(params: ListNotesParams, limit: number, deps: ListNotesDeps): ListNotesResult {
  const { db, repo } = deps;
  // biome-ignore lint/style/noNonNullAssertion: caller validated search is non-empty
  const escaped = buildFtsQuery(params.search!);
  if (escaped === null) {
    return { data: [], nextCursor: null };
  }

  const subtypes =
    params.subtype === undefined
      ? undefined
      : Array.isArray(params.subtype)
        ? params.subtype
        : [params.subtype];

  const subtypeFilter = subtypes
    ? sql`AND n.subtype IN (${sql.join(
        subtypes.map((s) => sql`${s}`),
        sql`, `,
      )})`
    : sql.empty();
  const archivedFilter =
    params.archived === undefined
      ? sql`AND n.archived = 0`
      : sql`AND n.archived = ${params.archived ? 1 : 0}`;
  const pinnedFilter =
    params.pinned === undefined ? sql.empty() : sql`AND n.pinned = ${params.pinned ? 1 : 0}`;
  const dueBeforeFilter =
    params.dueBefore === undefined ? sql.empty() : sql`AND n.due_at <= ${params.dueBefore}`;
  const hasReminderFilter =
    params.hasReminder === true
      ? sql`AND n.due_at IS NOT NULL AND n.reminded_at IS NULL`
      : sql.empty();
  const tagFilter =
    params.tag === undefined
      ? sql.empty()
      : sql`AND EXISTS (
          SELECT 1 FROM note_tags nt
          WHERE nt.note_id = n.id AND nt.tag = ${params.tag.trim().toLowerCase()}
        )`;
  const entityFilter =
    params.entityId === undefined
      ? sql.empty()
      : sql`AND EXISTS (
          SELECT 1 FROM note_entities ne
          WHERE ne.note_id = n.id AND ne.entity_id = ${params.entityId}
        )`;
  const sourceFilter =
    params.sourceId === undefined
      ? sql.empty()
      : sql`AND EXISTS (
          SELECT 1 FROM note_sources ns
          WHERE ns.note_id = n.id AND ns.source_id = ${params.sourceId}
        )`;

  const stmt = sql`
    SELECT n.id
    FROM notes_fts
    INNER JOIN notes n ON n.id = notes_fts.rowid
    WHERE notes_fts MATCH ${escaped}
      ${subtypeFilter}
      ${archivedFilter}
      ${pinnedFilter}
      ${dueBeforeFilter}
      ${hasReminderFilter}
      ${tagFilter}
      ${entityFilter}
      ${sourceFilter}
    ORDER BY ${params.hasReminder === true ? sql`n.due_at ASC, n.id DESC` : sql`notes_fts.rank`}
    LIMIT ${limit}
  `;
  const rows = db.all<{ id: number }>(stmt);
  const data = rows.map((r) => repo.get(r.id)).filter((n): n is NoteDetail => n !== null);

  // search path returns rank-sorted results; createdAt cursor is meaningless,
  // so we always return null. Pagination over search is left for a later
  // OFFSET-based path.
  return { data, nextCursor: null };
}

/**
 * Tokenize user search input → quoted FTS5 phrases joined by OR.
 * Returns `null` when no token survives sanitization (empty query → caller
 * should short-circuit to empty result).
 */
function buildFtsQuery(text: string): string | null {
  const tokens = text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

function parseCursor(cursor: ListNotesParams['cursor']): ParsedCursor | null {
  if (cursor === undefined) return null;
  if (typeof cursor === 'number') {
    return Number.isInteger(cursor) && cursor > 0 ? { createdAt: cursor } : null;
  }

  const composite = CURSOR_RE.exec(cursor);
  if (composite) {
    const createdAt = Number(composite[1]);
    const id = Number(composite[2]);
    if (createdAt <= 0 || id <= 0) return null;
    return {
      createdAt,
      id,
    };
  }

  const legacy = Number(cursor);
  return Number.isInteger(legacy) && legacy > 0 ? { createdAt: legacy } : null;
}

function formatCursor(createdAt: number, id: number): string {
  return `${createdAt}:${id}`;
}
