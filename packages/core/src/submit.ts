import { and, asc, eq, inArray } from 'drizzle-orm';
import { type DrizzleDB, getRawDatabase } from './db/connection';
import type { SubmissionLogRepository } from './db/repositories/types';
import { processingTasks, sources } from './db/schema';
import { utcNowMs } from './db/timestamp';
import { detectInputUrl } from './utils/input-detector';
import { validateSsrfIfEnabled } from './utils/ssrf';
import { normalizeUrl } from './utils/url-normalizer';

/** Fire-and-forget audit log — failures must never alter the return path. */
function safeLog(
  log: SubmissionLogRepository | undefined,
  data: Parameters<SubmissionLogRepository['create']>[0],
): void {
  try {
    log?.create(data);
  } catch {
    // Audit log failure must not mask the primary result
  }
}

export interface SubmitDeps {
  db: DrizzleDB;
  submissionLog?: SubmissionLogRepository;
  maxTextInputLength: number;
  origin?: 'user' | 'tracking';
  /**
   * Mirror of `GoldpanConfig.ssrfValidationEnabled`. Required so each caller
   * makes a deliberate choice — silent default would let a future call site
   * forget to plumb the flag and ship the strict behaviour even when the
   * operator opted out via `GOLDPAN_SSRF_VALIDATION_ENABLED=false`.
   */
  ssrfValidationEnabled: boolean;
  /**
   * Distinguishes neutral text submissions from subjective opinions. Drives
   * `processing_tasks.input_type` and downstream pipeline behavior (extracting
   * prompt, tags, NoteBubbleCard rendering). Defaults to 'fact' so URL/text
   * callers don't need to opt in. `record_thought` intent passes 'opinion'.
   */
  inputMode?: 'fact' | 'opinion';
}

export type SubmitRejectCode =
  | 'input_empty'
  | 'text_too_short'
  | 'text_too_long'
  | 'url_blocked'
  | 'url_invalid'
  | 'unknown';

export type SubmitResult =
  | {
      status: 'accepted';
      taskId: number;
      sourceId: number;
      warnings?: string[];
      urlCount?: number;
      /** Mirrors the deps.inputMode that produced this submission so callers
       * (and the web /input route) can route the response to a NoteBubbleCard
       * for opinion submissions without re-querying processing_tasks. */
      inputMode?: 'fact' | 'opinion';
    }
  | {
      status: 'duplicate';
      existingSourceId: number;
      /** First (earliest) pipeline task for the existing source. Lets the web
       * client deep-link to the original task without re-querying. May be `null`
       * for legacy sources whose tasks were all deleted. */
      existingTaskId: number | null;
      /** Original-form URL of the existing source — what the user originally
       * submitted, not the normalized form (which strips query params, etc.). */
      existingUrl: string;
    }
  | { status: 'rejected'; code: SubmitRejectCode; reason: string };

/**
 * Submit a raw input string (URL or text). Detects input type automatically.
 * Performs SSRF validation, URL normalization, dedup check, and DB insertion.
 * Does NOT handle auth, rate limiting, or i18n — those are caller concerns.
 */
export async function submitInput(rawInput: string, deps: SubmitDeps): Promise<SubmitResult> {
  const input = rawInput.trim();
  if (!input) {
    return { status: 'rejected', code: 'input_empty', reason: 'Input is empty' };
  }

  const detection = detectInputUrl(input);

  if (!detection.hasUrl) {
    return submitText(input, deps);
  }

  return submitUrl(detection.extractedUrl ?? '', input, detection, deps);
}

/**
 * Submit text content (non-URL input).
 */
export async function submitText(text: string, deps: SubmitDeps): Promise<SubmitResult> {
  const { db, submissionLog, maxTextInputLength, origin = 'user', inputMode = 'fact' } = deps;

  if (text.length < 4) {
    safeLog(submissionLog, {
      rawInput: text,
      result: 'rejected',
      reason: `Text length out of range (${text.length} chars, allowed: 4-${maxTextInputLength})`,
    });
    return {
      status: 'rejected',
      code: 'text_too_short',
      reason: `Text too short (min 4 chars, got ${text.length})`,
    };
  }
  if (text.length > maxTextInputLength) {
    safeLog(submissionLog, {
      rawInput: text,
      result: 'rejected',
      reason: `Text length out of range (${text.length} chars, allowed: 4-${maxTextInputLength})`,
    });
    return {
      status: 'rejected',
      code: 'text_too_long',
      reason: `Text too long (max ${maxTextInputLength} chars, got ${text.length})`,
    };
  }

  const rawDb = getRawDatabase(db);
  const result = rawDb
    .transaction(() => {
      const now = utcNowMs();
      const [source] = db
        .insert(sources)
        .values({
          kind: 'user',
          rawContent: text,
          normalizedUrl: null,
          originalUrl: null,
          status: 'processing',
          origin,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all();

      const [task] = db
        .insert(processingTasks)
        .values({
          sourceId: source.id,
          type: 'pipeline',
          status: 'pending',
          inputType: inputMode === 'opinion' ? 'opinion' : 'text',
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all();

      return { sourceId: source.id, taskId: task.id };
    })
    .immediate();

  safeLog(submissionLog, {
    rawInput: text,
    result: 'accepted',
    taskId: result.taskId,
    sourceId: result.sourceId,
  });

  return {
    status: 'accepted',
    taskId: result.taskId,
    sourceId: result.sourceId,
    inputMode,
  };
}

/**
 * Submit a URL for processing. Called internally by submitInput or directly.
 */
async function submitUrl(
  rawUrl: string,
  rawInput: string,
  detection: ReturnType<typeof detectInputUrl>,
  deps: SubmitDeps,
): Promise<SubmitResult> {
  const { db, submissionLog, origin = 'user', ssrfValidationEnabled } = deps;

  // Pre-validate URL format before SSRF check so malformed URLs get url_invalid, not url_blocked
  try {
    new URL(rawUrl);
  } catch {
    safeLog(submissionLog, {
      rawInput,
      result: 'rejected',
      reason: 'Invalid URL format (parse failed)',
    });
    return { status: 'rejected', code: 'url_invalid', reason: 'Invalid URL format' };
  }

  try {
    await validateSsrfIfEnabled(rawUrl, ssrfValidationEnabled);
  } catch (err) {
    safeLog(submissionLog, {
      rawInput,
      result: 'rejected',
      reason: err instanceof Error ? err.message : 'SSRF validation failed',
    });
    return { status: 'rejected', code: 'url_blocked', reason: 'URL blocked by security policy' };
  }

  const normalizedUrlStr = (() => {
    try {
      return normalizeUrl(rawUrl);
    } catch {
      return null;
    }
  })();
  if (!normalizedUrlStr) {
    safeLog(submissionLog, {
      rawInput,
      result: 'rejected',
      reason: 'Invalid URL format',
    });
    return { status: 'rejected', code: 'url_invalid', reason: 'Invalid URL format' };
  }

  const rawDb = getRawDatabase(db);
  const result = rawDb
    .transaction(() => {
      const existing = db
        .select()
        .from(sources)
        .where(
          and(
            eq(sources.normalizedUrl, normalizedUrlStr),
            inArray(sources.status, ['processing', 'confirmed']),
          ),
        )
        .get();
      if (existing) {
        const firstTask = db
          .select({ id: processingTasks.id })
          .from(processingTasks)
          .where(eq(processingTasks.sourceId, existing.id))
          .orderBy(asc(processingTasks.id))
          .limit(1)
          .get();
        return {
          isDuplicate: true as const,
          existingSourceId: existing.id,
          existingTaskId: firstTask?.id ?? null,
          // External sources (the only kind that participates in URL-dedup)
          // are guaranteed to have originalUrl by the schema CHECK; fall back
          // to the normalized form so the type stays string.
          existingUrl: existing.originalUrl ?? normalizedUrlStr,
        };
      }

      const now = utcNowMs();
      const [source] = db
        .insert(sources)
        .values({
          kind: 'external',
          originalUrl: rawUrl,
          normalizedUrl: normalizedUrlStr,
          status: 'processing',
          origin,
          metadata: detection.userAnnotation
            ? JSON.stringify({ userAnnotation: detection.userAnnotation })
            : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all();

      const [task] = db
        .insert(processingTasks)
        .values({
          sourceId: source.id,
          type: 'pipeline',
          status: 'pending',
          inputType: 'url',
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all();

      return { isDuplicate: false as const, sourceId: source.id, taskId: task.id };
    })
    .immediate();

  if (result.isDuplicate) {
    safeLog(submissionLog, {
      rawInput,
      result: 'duplicate',
      reason: `Duplicate of source #${result.existingSourceId}`,
    });
    return {
      status: 'duplicate',
      existingSourceId: result.existingSourceId,
      existingTaskId: result.existingTaskId,
      existingUrl: result.existingUrl,
    };
  }

  safeLog(submissionLog, {
    rawInput,
    result: 'accepted',
    taskId: result.taskId,
    sourceId: result.sourceId,
  });

  const warnings = detection.warnings;

  return {
    status: 'accepted',
    taskId: result.taskId,
    sourceId: result.sourceId,
    ...(warnings ? { warnings } : {}),
    ...(detection.urlCount ? { urlCount: detection.urlCount } : {}),
  };
}
