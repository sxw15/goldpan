// 仅保留行为可观测的两类：`memo` 触发提醒（dueAt 输入 / banner），`note` 是其它所有
// 笔记的默认桶。早期版本曾按内容性质细分 idea / reflection / observation，但这三类
// 没有任何下游分支差异，LLM 也无法基于一句话稳定分对，反而让用户疑惑 —— 见 0027
// migration 与下游 UI/CSS/i18n 同步收敛。
export const NOTE_SUBTYPES = ['memo', 'note'] as const;
export type NoteSubtype = (typeof NOTE_SUBTYPES)[number];

export const NOTE_SOURCE_RELATIONS = ['reference', 'derived_from'] as const;
export type NoteSourceRelation = (typeof NOTE_SOURCE_RELATIONS)[number];

export const PROMOTE_NOTE_MIN_CONTENT_LENGTH = 600;

export interface NoteDetail {
  id: number;
  content: string;
  contentTranslated: string | null;
  language: string | null;
  subtype: NoteSubtype;
  pinned: boolean;
  archived: boolean;
  sourceMessageId: number | null;
  /**
   * P5: derived from sourceMessageId join. NULL when sourceMessageId is null,
   * the conversation was deleted, OR the conversation belongs to a non-web
   * channel (IM origin) — web UI can't open those, so we suppress the link.
   * Surfaced by §8 to render "来自对话 X 月 Y 日" hyperlink.
   */
  conversationId: number | null;
  tags: string[];
  linkedEntities: Array<{ id: number; name: string }>;
  linkedSources: Array<{
    id: number;
    relation: NoteSourceRelation;
    title: string | null;
    originalUrl: string | null;
    rawContentPreview?: string | null;
  }>;
  /** Unix-ms timestamp the user wants a reminder for. Null = no reminder. */
  dueAt: number | null;
  /** Unix-ms timestamp at which client displayed the reminder. Null = pending. */
  remindedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateNoteInput {
  content: string;
  subtype?: NoteSubtype;
  language?: string;
  tags?: string[];
  linkedEntityIds?: number[];
  linkedSourceId?: number;
  sourceMessageId?: number;
}

export interface UpdateNoteInput {
  content?: string;
  subtype?: NoteSubtype;
  tags?: string[];
  linkedEntityIds?: number[];
  /**
   * B9: 替换 relation='reference' 的 note_sources 全集。relation='derived_from'
   * （promote 创建的链）保持不动 —— 用户不应能从 PATCH 路径打破溯源链。
   * 不存在的 source id 静默丢弃（软校验，与 createNote 一致）。
   */
  linkedSourceIds?: number[];
  pinned?: boolean;
  archived?: boolean;
  /** Unix-ms. Pass `null` to clear. */
  dueAt?: number | null;
}

export interface ListNotesParams {
  subtype?: NoteSubtype | NoteSubtype[];
  tag?: string;
  entityId?: number;
  sourceId?: number;
  pinned?: boolean;
  archived?: boolean;
  /** FTS5 query. Empty / whitespace string is treated as no search. */
  search?: string;
  /** Default 50, capped at 200. */
  limit?: number;
  /** Opaque non-search pagination cursor. Numeric createdAt cursors are accepted for backward compatibility. */
  cursor?: string | number;
  /** Unix-ms. Filters to notes whose dueAt <= this cutoff (client poll uses Date.now()). */
  dueBefore?: number;
  /** When `true`, returns only notes where dueAt IS NOT NULL AND remindedAt IS NULL.
   *  "Pending reminder" — narrow name kept to match spec § P7.4 D10. */
  hasReminder?: boolean;
}

export interface ListNotesResult {
  data: NoteDetail[];
  /** `null` when no more pages or when search path returns rank-sorted results. */
  nextCursor: string | null;
}

export interface MarkRemindedOptions {
  /** Optional CAS guard from the banner snapshot; rejects if dueAt changed. */
  expectedDueAt?: number;
}

// NotesRepository interface lives in notes/ because it is the user-note write
// model, while db/repositories/types.ts owns the source-view read model over
// `sources`. P6 renamed that read model to SourceView*; this module keeps the
// user-note domain names.
export interface NotesRepository {
  create(input: CreateNoteInput): NoteDetail;
  get(id: number): NoteDetail | null;
  list(params: ListNotesParams): ListNotesResult;
  update(id: number, patch: UpdateNoteInput): NoteDetail | null;
  delete(id: number): boolean;
  searchByContent(query: string, limit: number): NoteDetail[];
  /** Mark this note as reminded now. Returns the new remindedAt ms. Throws if note missing. */
  markReminded(id: number, options?: MarkRemindedOptions): number;
}
