// apps/server/src/routes/user-notes.ts
import { promoteNoteToSource, translateNote } from '@goldpan/core';
import {
  NOTE_SUBTYPES,
  type NoteSubtype,
  type UpdateNoteInput,
} from '@goldpan/core/db/repositories';
import {
  getErrorCode,
  parseId,
  parseJsonBody,
  parsePositiveIntParam,
  type RouteContext,
  respond,
  respondError,
} from './types.js';

function parseSubtype(v: unknown): NoteSubtype | undefined {
  if (typeof v !== 'string') return undefined;
  if ((NOTE_SUBTYPES as readonly string[]).includes(v)) return v as NoteSubtype;
  // Backward compatibility for pre-0027 clients/links. The migration collapses
  // existing idea/reflection/observation rows to note, so route inputs should
  // resolve the same way instead of rejecting or widening a query to "all".
  return v === 'idea' || v === 'reflection' || v === 'observation' ? 'note' : undefined;
}

function parseSubtypeQuery(v: string | null): NoteSubtype | NoteSubtype[] | undefined {
  if (!v) return undefined;
  const parts = v.split(',').map((s) => s.trim());
  const valid = Array.from(
    new Set(parts.map(parseSubtype).filter((p): p is NoteSubtype => p !== undefined)),
  );
  if (valid.length === 0) return undefined;
  return valid.length === 1 ? valid[0] : valid;
}

// Minor cap: 30 tags × 64 chars/tag —— 防 caller 注入超长 / 超多 tag 占 DB
// + FTS 内存。spec TODO #12 后续做长期监控；当前两个上限是 sane default。
const MAX_TAGS_PER_NOTE = 30;
const MAX_TAG_LENGTH = 64;

interface TagValidationError {
  code: 'too_many_tags' | 'tag_too_long';
  message: string;
}

function parseStringArray(v: unknown): string[] | undefined | TagValidationError {
  if (!Array.isArray(v)) return undefined;
  const clean = v.filter((s): s is string => typeof s === 'string');
  if (clean.length > MAX_TAGS_PER_NOTE) {
    return {
      code: 'too_many_tags',
      message: `tags must have at most ${MAX_TAGS_PER_NOTE} entries (got ${clean.length})`,
    };
  }
  const tooLong = clean.find((s) => s.length > MAX_TAG_LENGTH);
  if (tooLong !== undefined) {
    return {
      code: 'tag_too_long',
      message: `each tag must be at most ${MAX_TAG_LENGTH} chars`,
    };
  }
  return v.length === 0 || clean.length > 0 ? clean : undefined;
}

function isTagValidationError(v: unknown): v is TagValidationError {
  return (
    typeof v === 'object' &&
    v !== null &&
    'code' in v &&
    (v.code === 'too_many_tags' || v.code === 'tag_too_long')
  );
}

function parsePositiveIntArray(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const clean = v.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0);
  return v.length === 0 || clean.length > 0 ? clean : undefined;
}

function parseBoolParam(v: string | null): boolean | undefined {
  return v === 'true' ? true : v === 'false' ? false : undefined;
}

const MAX_VALID_DATE_MS = 8_640_000_000_000_000;

function isValidUnixMs(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_VALID_DATE_MS
  );
}

function parseOptionalUnixMsQuery(
  res: RouteContext['res'],
  url: URL,
  name: string,
): number | undefined | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    respondError(res, 400, `invalid_${name}`, `${name} must be a unix-ms integer`);
    return null;
  }
  const parsed = Number(raw);
  if (!isValidUnixMs(parsed)) {
    respondError(res, 400, `invalid_${name}`, `${name} must be a unix-ms integer`);
    return null;
  }
  return parsed;
}

function parseOptionalPositiveIntQuery(
  res: RouteContext['res'],
  url: URL,
  name: string,
): number | undefined | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const parsed = parsePositiveIntParam(raw);
  if (parsed === null) {
    respondError(res, 400, 'invalid_query', `${name} must be a positive integer`);
    return null;
  }
  return parsed;
}

function parseCursorQuery(res: RouteContext['res'], url: URL): string | undefined | null {
  const raw = url.searchParams.get('cursor');
  if (raw === null) return undefined;
  if (/^[1-9]\d*(?::[1-9]\d*)?$/.test(raw)) {
    return raw;
  }
  respondError(res, 400, 'invalid_query', 'cursor must be a valid pagination cursor');
  return null;
}

/**
 * Handle /user-notes/* routes.
 * P1 user-authored notes (distinct from the legacy /notes source-view).
 */
export async function handleUserNoteRoutes(ctx: RouteContext): Promise<void> {
  const { req, res, url, segments, handle, readBody } = ctx;
  const { repos } = handle;
  // Hot (no-restart) setting — read the live snapshot so a Settings change to the
  // text-input limit applies to note create/update without a restart.
  const maxLen = handle.configStore.getSnapshot().config.maxTextInputLength;

  // ─── POST /user-notes ────────────────────────────────────────
  if (req.method === 'POST' && segments.length === 0) {
    const body = await readBody();
    if (body === null) return;
    const parsed = parseJsonBody<{
      content?: unknown;
      subtype?: unknown;
      language?: unknown;
      tags?: unknown;
      linkedEntityIds?: unknown;
      linkedSourceId?: unknown;
      sourceMessageId?: unknown;
    }>(res, body);
    if (parsed === null) return;

    if (typeof parsed.content !== 'string' || parsed.content.trim().length === 0) {
      respondError(res, 400, 'invalid_content', 'content is required');
      return;
    }
    if (parsed.content.length > maxLen) {
      respondError(res, 400, 'content_too_long', `content exceeds ${maxLen} chars`);
      return;
    }
    if (parsed.subtype !== undefined && parseSubtype(parsed.subtype) === undefined) {
      respondError(
        res,
        400,
        'invalid_subtype',
        `subtype must be one of: ${NOTE_SUBTYPES.join(',')}`,
      );
      return;
    }

    const linkedSourceId =
      typeof parsed.linkedSourceId === 'number' &&
      Number.isInteger(parsed.linkedSourceId) &&
      parsed.linkedSourceId > 0
        ? parsed.linkedSourceId
        : undefined;
    const sourceMessageId =
      typeof parsed.sourceMessageId === 'number' &&
      Number.isInteger(parsed.sourceMessageId) &&
      parsed.sourceMessageId > 0
        ? parsed.sourceMessageId
        : undefined;

    const tagsResult = parseStringArray(parsed.tags);
    if (isTagValidationError(tagsResult)) {
      respondError(res, 400, tagsResult.code, tagsResult.message);
      return;
    }
    try {
      const detail = repos.notes.create({
        content: parsed.content,
        subtype: parseSubtype(parsed.subtype),
        language: typeof parsed.language === 'string' ? parsed.language : undefined,
        tags: tagsResult,
        linkedEntityIds: parsePositiveIntArray(parsed.linkedEntityIds),
        linkedSourceId,
        sourceMessageId,
      });
      respond(res, 201, detail);
    } catch (err) {
      handle.logger.error('POST /user-notes failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'failed to create note');
    }
    return;
  }

  // ─── GET /user-notes ─────────────────────────────────────────
  if (req.method === 'GET' && segments.length === 0) {
    req.resume();
    const entityId = parseOptionalPositiveIntQuery(res, url, 'entityId');
    if (entityId === null) return;
    const sourceId = parseOptionalPositiveIntQuery(res, url, 'sourceId');
    if (sourceId === null) return;
    const limit = parseOptionalPositiveIntQuery(res, url, 'limit');
    if (limit === null) return;
    const cursor = parseCursorQuery(res, url);
    if (cursor === null) return;

    const dueBefore = parseOptionalUnixMsQuery(res, url, 'dueBefore');
    if (dueBefore === null) return;
    const hasReminderRaw = url.searchParams.get('hasReminder');
    // Semantically only `true` makes sense — `?hasReminder=false` is equivalent
    // to omitting the filter (return all). We intentionally don't use
    // parseBoolParam here; future maintainer: keep this asymmetric.
    const hasReminder = hasReminderRaw === 'true' ? true : undefined;

    try {
      const result = repos.notes.list({
        subtype: parseSubtypeQuery(url.searchParams.get('subtype')),
        tag: url.searchParams.get('tag') ?? undefined,
        entityId,
        sourceId,
        search: url.searchParams.get('search') ?? undefined,
        limit,
        cursor,
        archived: parseBoolParam(url.searchParams.get('archived')),
        pinned: parseBoolParam(url.searchParams.get('pinned')),
        dueBefore,
        hasReminder,
      });
      respond(res, 200, result);
    } catch (err) {
      handle.logger.error('GET /user-notes failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'failed to list notes');
    }
    return;
  }

  // ─── /user-notes/:id ─────────────────────────────────────────
  if (segments.length === 1) {
    const id = parseId(segments[0]);
    if (id === null) {
      respondError(res, 400, 'invalid_id', 'invalid note id');
      return;
    }

    if (req.method === 'GET') {
      req.resume();
      const detail = repos.notes.get(id);
      if (!detail) {
        respondError(res, 404, 'note_not_found', 'note not found');
        return;
      }
      respond(res, 200, detail);
      return;
    }

    if (req.method === 'PATCH') {
      const body = await readBody();
      if (body === null) return;
      const parsed = parseJsonBody<Record<string, unknown>>(res, body);
      if (parsed === null) return;

      if (parsed.content !== undefined) {
        if (typeof parsed.content !== 'string' || parsed.content.length === 0) {
          respondError(res, 400, 'invalid_content', 'content must be non-empty string');
          return;
        }
        if (parsed.content.length > maxLen) {
          respondError(res, 400, 'content_too_long', 'content too long');
          return;
        }
      }
      if (parsed.subtype !== undefined && parseSubtype(parsed.subtype) === undefined) {
        respondError(
          res,
          400,
          'invalid_subtype',
          `subtype must be one of: ${NOTE_SUBTYPES.join(',')}`,
        );
        return;
      }

      // Explicit field destructure — unknown fields in the body are silently
      // dropped at the route boundary so dirty data cannot reach the repo
      // (system-boundary validation; see CLAUDE.md §防御纪律).
      const patch: UpdateNoteInput = {};
      if (typeof parsed.content === 'string') patch.content = parsed.content;
      if (parsed.subtype !== undefined) {
        const t = parseSubtype(parsed.subtype);
        if (t !== undefined) patch.subtype = t;
      }
      if (parsed.tags !== undefined) {
        const arr = parseStringArray(parsed.tags);
        if (isTagValidationError(arr)) {
          respondError(res, 400, arr.code, arr.message);
          return;
        }
        if (arr !== undefined) patch.tags = arr;
      }
      if (parsed.linkedEntityIds !== undefined) {
        const arr = parsePositiveIntArray(parsed.linkedEntityIds);
        if (arr !== undefined) patch.linkedEntityIds = arr;
      }
      // B9: 加 linkedSourceIds patch（仅替换 relation='reference' 行）
      if (parsed.linkedSourceIds !== undefined) {
        const arr = parsePositiveIntArray(parsed.linkedSourceIds);
        if (arr !== undefined) patch.linkedSourceIds = arr;
      }
      if (typeof parsed.pinned === 'boolean') patch.pinned = parsed.pinned;
      if (typeof parsed.archived === 'boolean') patch.archived = parsed.archived;
      if (parsed.dueAt !== undefined) {
        // Accept number | null literally; reject non-numeric / non-null。
        // 不拒绝过去时间 —— 用户可能在 import / backdate 历史 reminder，
        // markReminded 已有 grace 不会失败循环。
        if (parsed.dueAt === null) {
          patch.dueAt = null;
        } else if (isValidUnixMs(parsed.dueAt)) {
          patch.dueAt = parsed.dueAt;
        } else {
          respondError(res, 400, 'invalid_dueAt', 'dueAt must be a unix-ms integer or null');
          return;
        }
      }

      try {
        const detail = repos.notes.update(id, patch);
        if (!detail) {
          respondError(res, 404, 'note_not_found', 'note not found');
          return;
        }
        respond(res, 200, detail);
      } catch (err) {
        handle.logger.error(`PATCH /user-notes/${id} failed`, {
          err: err instanceof Error ? err.message : String(err),
        });
        respondError(res, 500, 'internal', 'failed to update note');
      }
      return;
    }

    if (req.method === 'DELETE') {
      req.resume();
      const deleted = repos.notes.delete(id);
      if (!deleted) {
        respondError(res, 404, 'note_not_found', 'note not found');
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }
  }

  // ─── POST /user-notes/:id/promote ────────────────────────────
  if (req.method === 'POST' && segments.length === 2 && segments[1] === 'promote') {
    const id = parseId(segments[0]);
    if (id === null) {
      respondError(res, 400, 'invalid_id', 'invalid note id');
      return;
    }
    req.resume();

    try {
      const result = await promoteNoteToSource(id, {
        notesRepo: repos.notes,
        db: handle.db,
        submitDeps: {
          db: handle.db,
          submissionLog: repos.submissionLog,
          // Hot (no-restart): live snapshot; ssrf stays frozen (restart-required).
          maxTextInputLength: handle.configStore.getSnapshot().config.maxTextInputLength,
          ssrfValidationEnabled: handle.config.ssrfValidationEnabled,
        },
      });
      respond(res, 200, result);
    } catch (err) {
      // PromoteNoteError carries `code` + `reason`. We discriminate via
      // `getErrorCode` (duck-typed code reader) rather than `instanceof`
      // because the value-class import from `@goldpan/core` resolves to `any`
      // under NodeNext resolution against this monorepo's dist barrel
      // (relative `.d.ts` re-exports lack explicit `.js` extensions →
      // `instanceof PromoteNoteError` won't narrow `unknown`). Existing
      // routes (digest.ts) use the same pattern.
      const code = getErrorCode(err);
      if (
        code === 'note_not_found' ||
        code === 'note_archived' ||
        code === 'note_empty' ||
        code === 'note_too_short' ||
        code === 'note_too_long' ||
        code === 'submit_failed'
      ) {
        const status = code === 'note_not_found' ? 404 : code === 'submit_failed' ? 500 : 400;
        const reason =
          err instanceof Error
            ? (((err as { reason?: unknown }).reason as string | undefined) ?? err.message)
            : 'promote failed';
        respondError(res, status, code, reason);
        return;
      }
      handle.logger.error(`POST /user-notes/${id}/promote failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'failed to promote note');
    }
    return;
  }

  // ─── POST /user-notes/:id/translate ──────────────────────────
  if (req.method === 'POST' && segments.length === 2 && segments[1] === 'translate') {
    const id = parseId(segments[0]);
    if (id === null) {
      respondError(res, 400, 'invalid_id', 'invalid note id');
      return;
    }
    req.resume();

    try {
      const result = await translateNote(id, {
        notesRepo: repos.notes,
        db: handle.db,
        callLlm: handle.callLlm,
        llmCallRepo: repos.llmCall,
        language: handle.config.language,
        logPayloads: handle.config.llmLogPayloads ?? false,
      });
      respond(res, 200, result);
    } catch (err) {
      // Mirror promote: duck-typed code reader because the value-class
      // import from `@goldpan/core` doesn't narrow under NodeNext + dist
      // barrel re-exports.
      const code = getErrorCode(err);
      if (
        code === 'note_not_found' ||
        code === 'note_archived' ||
        code === 'note_empty' ||
        code === 'already_target_language' ||
        code === 'note_changed' ||
        code === 'translate_failed'
      ) {
        const status =
          code === 'note_not_found'
            ? 404
            : code === 'note_changed'
              ? 409
              : code === 'translate_failed'
                ? 500
                : 400;
        const reason =
          err instanceof Error
            ? (((err as { reason?: unknown }).reason as string | undefined) ?? err.message)
            : 'translate failed';
        respondError(res, status, code, reason);
        return;
      }
      handle.logger.error(`POST /user-notes/${id}/translate failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'failed to translate note');
    }
    return;
  }

  // ─── POST /user-notes/:id/mark-reminded ──────────────────────────
  if (req.method === 'POST' && segments.length === 2 && segments[1] === 'mark-reminded') {
    const id = parseId(segments[0]);
    if (id === null) {
      respondError(res, 400, 'invalid_id', 'invalid note id');
      return;
    }
    const body = await readBody();
    if (body === null) return;
    let expectedDueAt: number | undefined;
    if (body.trim().length > 0) {
      const parsed = parseJsonBody<Record<string, unknown>>(res, body);
      if (parsed === null) return;
      if (parsed.expectedDueAt !== undefined) {
        if (!isValidUnixMs(parsed.expectedDueAt)) {
          respondError(
            res,
            400,
            'invalid_expectedDueAt',
            'expectedDueAt must be a unix-ms integer',
          );
          return;
        }
        expectedDueAt = parsed.expectedDueAt;
      }
    }
    try {
      const remindedAt = repos.notes.markReminded(id, { expectedDueAt });
      respond(res, 200, { remindedAt });
    } catch (err) {
      // Mirror promote/translate: discriminate via central `getErrorCode`
      // (duck-typed code reader) rather than message regex.
      if (getErrorCode(err) === 'note_not_found') {
        const reason =
          err instanceof Error
            ? (((err as { reason?: unknown }).reason as string | undefined) ?? err.message)
            : 'note not found';
        respondError(res, 404, 'note_not_found', reason);
        return;
      }
      if (getErrorCode(err) === 'note_reminder_not_pending') {
        const reason =
          err instanceof Error
            ? (((err as { reason?: unknown }).reason as string | undefined) ?? err.message)
            : 'note reminder is not pending';
        const statusValue = (err as { status?: unknown }).status;
        const status = statusValue === 400 ? 400 : 409;
        respondError(res, status, 'note_reminder_not_pending', reason);
        return;
      }
      handle.logger.error(`POST /user-notes/${id}/mark-reminded failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'failed to mark reminded');
    }
    return;
  }

  req.resume();
  respondError(res, 404, 'not_found', 'Not found');
}
