import type { ZodError } from 'zod';

export type CollectorErrorCode =
  | 'FETCH_FAILED'
  | 'PARSE_FAILED'
  | 'TIMEOUT'
  | 'CONTENT_EMPTY'
  | 'ABORTED'
  | 'NOT_FOUND'
  | 'RATE_LIMIT'
  | 'INVALID_REQUEST'
  | 'UPSTREAM';

/**
 * Error contract for collector plugins (spec §9.3, §8.4 R5).
 * Pipeline inspects `code`, `retryable`, and `terminal` to decide error handling
 * and whether the registry may fall through to the next matching collector.
 *
 * Retryability rules:
 * - TIMEOUT: always true
 * - FETCH_FAILED: depends on cause (too many redirects = true; missing Location / bad protocol = false)
 * - PARSE_FAILED: always false
 * - CONTENT_EMPTY: always false
 * - ABORTED: always false (collect was cancelled via AbortSignal; not a transient failure)
 * - NOT_FOUND / INVALID_REQUEST: always false (semantic — the resource is gone or the URL is malformed)
 * - RATE_LIMIT: always true (transient — retry after backoff)
 * - UPSTREAM: depends on the upstream status (5xx = true, others = caller's judgement)
 *
 * Terminal semantics (spec §8.4 R5):
 * - `terminal = true` — the collector positively identified the resource as its own and failed
 *   semantically (e.g. GitHub API returned 404 for a repo). The registry MUST stop here and not
 *   fall through to the next matching collector.
 * - `terminal = false` (default) — transient or collector-specific failure; the registry may try
 *   the next matching collector. Preserves backward compatibility with existing callers.
 */
export class CollectorError extends Error {
  readonly code: CollectorErrorCode;
  readonly retryable: boolean;
  readonly terminal: boolean;

  constructor(
    message: string,
    code: CollectorErrorCode,
    retryable: boolean,
    cause?: unknown,
    terminal: boolean = false,
  ) {
    super(message, cause != null ? { cause } : undefined);
    this.name = 'CollectorError';
    this.code = code;
    this.retryable = retryable;
    this.terminal = terminal;
  }
}

/**
 * Extracts a human-readable string from an AbortSignal's reason.
 * Used when building ABORTED CollectorError messages so callers can see
 * why the signal was fired (e.g. registry per-collector timeout).
 */
export function formatAbortSignalReason(signal: AbortSignal): string {
  const r = signal.reason;
  if (r === undefined || r === null) {
    return 'Reason not provided (signal.reason is empty)';
  }
  if (r instanceof Error) {
    return r.message;
  }
  if (typeof r === 'string') {
    return r;
  }
  try {
    return String(r);
  } catch {
    return 'Reason could not be serialized';
  }
}

export class ToolOutputValidationError extends Error {
  readonly toolName: string;
  readonly pluginName: string;
  readonly zodError: ZodError;

  constructor(toolName: string, pluginName: string, zodError: ZodError) {
    super(`Tool output validation failed for ${pluginName}/${toolName}: ${zodError.message}`);
    this.name = 'ToolOutputValidationError';
    this.toolName = toolName;
    this.pluginName = pluginName;
    this.zodError = zodError;
  }
}
