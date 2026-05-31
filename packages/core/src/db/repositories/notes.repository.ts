import { and, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { createNote } from '../../notes/create';
import { deleteNote } from '../../notes/delete';
import { listNotes } from '../../notes/list';
import type {
  CreateNoteInput,
  ListNotesParams,
  ListNotesResult,
  MarkRemindedOptions,
  NoteDetail,
  NoteSourceRelation,
  NoteSubtype,
  NotesRepository,
  UpdateNoteInput,
} from '../../notes/types';
import { updateNote } from '../../notes/update';
import type { DrizzleDB } from '../connection';
import {
  conversationMessages,
  conversations,
  entities,
  noteEntities,
  noteSources,
  notes,
  noteTags,
  sources,
} from '../schema';
import { utcNowMs } from '../timestamp';

const WEB_SESSION_KEY = 'web:default';

/**
 * Repository-level "note not found" signal carrying a stable `code` for route
 * discrimination. Mirrors the `code` + `reason` shape of `PromoteNoteError` /
 * `TranslateNoteError` so consumers (routes) can use the central
 * `getErrorCode(err) === 'note_not_found'` pattern instead of message regex.
 */
export class NoteNotFoundError extends Error {
  readonly code = 'note_not_found';
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'NoteNotFoundError';
  }
}

export class NoteReminderNotPendingError extends Error {
  readonly code = 'note_reminder_not_pending';
  constructor(
    public readonly reason: string,
    public readonly status: 400 | 409 = 409,
  ) {
    super(reason);
    this.name = 'NoteReminderNotPendingError';
  }
}

export class SqliteNotesRepository implements NotesRepository {
  constructor(private db: DrizzleDB) {}

  create(input: CreateNoteInput): NoteDetail {
    return createNote(input, { db: this.db, repo: this });
  }

  get(id: number): NoteDetail | null {
    const row = this.db.select().from(notes).where(eq(notes.id, id)).get();
    if (!row) return null;

    const tags = this.db
      .select({ tag: noteTags.tag })
      .from(noteTags)
      .where(eq(noteTags.noteId, id))
      .all()
      .map((r) => r.tag);

    const linkedEntities = this.db
      .select({ id: entities.id, name: entities.name })
      .from(noteEntities)
      .innerJoin(entities, eq(entities.id, noteEntities.entityId))
      .where(eq(noteEntities.noteId, id))
      .all();

    const linkedSources = this.db
      .select({
        id: sources.id,
        relation: noteSources.relation,
        title: sources.title,
        originalUrl: sources.originalUrl,
        rawContentPreview: sql<
          string | null
        >`CASE WHEN ${sources.kind} = 'user' THEN substr(${sources.rawContent}, 1, 80) ELSE NULL END`.as(
          'raw_content_preview',
        ),
      })
      .from(noteSources)
      .innerJoin(sources, eq(sources.id, noteSources.sourceId))
      .where(eq(noteSources.noteId, id))
      .all();

    // P5: sourceMessageId → conversationId 反查（§8 sourceMessage 溯源用）。
    // 若 sourceMessageId 为空，或消息 / 对话已被删除（FK ON DELETE CASCADE），
    // 则 conversationId 保持 null —— 前端据此决定是否渲染"来自对话"链接。
    //
    // I8: only expose conversations that the web routes can open. The route
    // contract is stricter than channel_id='web': GET /conversations/:id and
    // /input conversation dispatch both require session_key='web:default'.
    // sourceMessageId itself remains for audit, but a null conversationId
    // suppresses the front-end "source conversation" link.
    let conversationId: number | null = null;
    if (row.sourceMessageId != null) {
      const msg = this.db
        .select({
          conversationId: conversationMessages.conversationId,
          sessionKey: conversations.sessionKey,
        })
        .from(conversationMessages)
        .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
        .where(eq(conversationMessages.id, row.sourceMessageId))
        .get();
      conversationId = msg?.sessionKey === WEB_SESSION_KEY ? msg.conversationId : null;
    }

    return {
      id: row.id,
      content: row.content,
      contentTranslated: row.contentTranslated,
      language: row.language,
      subtype: row.subtype as NoteSubtype,
      pinned: Boolean(row.pinned),
      archived: Boolean(row.archived),
      sourceMessageId: row.sourceMessageId,
      conversationId,
      tags,
      linkedEntities,
      linkedSources: linkedSources.map((s) => ({
        id: s.id,
        relation: s.relation as NoteSourceRelation,
        title: s.title,
        originalUrl: s.originalUrl,
        rawContentPreview: s.rawContentPreview,
      })),
      dueAt: row.dueAt,
      remindedAt: row.remindedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  list(params: ListNotesParams): ListNotesResult {
    return listNotes(params, { db: this.db, repo: this });
  }

  update(id: number, patch: UpdateNoteInput): NoteDetail | null {
    return updateNote(id, patch, { db: this.db, repo: this });
  }

  markReminded(id: number, options: MarkRemindedOptions = {}): number {
    const now = utcNowMs();
    // B10: 5s grace 容忍 client/server 时钟漂移。client banner 到达稍早于
    // server 视角的 dueAt 时仍 mark 成功，避免反复 409 重试。
    const MARK_REMINDED_GRACE_MS = 5_000;
    const conditions = [
      eq(notes.id, id),
      isNotNull(notes.dueAt),
      isNull(notes.remindedAt),
      lte(notes.dueAt, now + MARK_REMINDED_GRACE_MS),
    ];
    if (options.expectedDueAt !== undefined) {
      conditions.push(eq(notes.dueAt, options.expectedDueAt));
    }

    const result = this.db
      .update(notes)
      .set({ remindedAt: now, updatedAt: now })
      .where(and(...conditions))
      .run();
    if (result.changes > 0) return now;

    const current = this.db
      .select({ dueAt: notes.dueAt, remindedAt: notes.remindedAt })
      .from(notes)
      .where(eq(notes.id, id))
      .get();
    if (!current) throw new NoteNotFoundError(`Note ${id} not found`);
    if (current.dueAt === null) {
      throw new NoteReminderNotPendingError(`Note ${id} has no due reminder`, 400);
    }
    if (options.expectedDueAt !== undefined && current.dueAt !== options.expectedDueAt) {
      throw new NoteReminderNotPendingError(`Note ${id} reminder dueAt changed`, 409);
    }
    if (current.remindedAt !== null) {
      throw new NoteReminderNotPendingError(`Note ${id} reminder already marked`, 409);
    }
    if (current.dueAt > now + 5_000) {
      throw new NoteReminderNotPendingError(`Note ${id} reminder is not due yet`, 409);
    }
    throw new NoteReminderNotPendingError(`Note ${id} reminder is not pending`, 409);
  }

  delete(id: number): boolean {
    return deleteNote(id, { db: this.db });
  }

  searchByContent(query: string, limit: number): NoteDetail[] {
    return listNotes({ search: query, limit }, { db: this.db, repo: this }).data;
  }
}
