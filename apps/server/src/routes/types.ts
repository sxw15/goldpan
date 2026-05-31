// apps/server/src/routes/types.ts
import type http from 'node:http';
import type { BootstrapHandle } from '@goldpan/core/bootstrap';

export interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  /** Path segments after the route prefix, e.g. ['tasks', '42'] */
  segments: string[];
  handle: BootstrapHandle;
  /** Read POST/PUT body. Returns null if response was already sent (413/408). */
  readBody: () => Promise<string | null>;
  /** Get client IP for rate limiting. */
  getClientIp: () => string;
  /** Whether the debug API is enabled. */
  debugApiEnabled: boolean;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void>;

/** Send a JSON response. */
export function respond(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Send a JSON error response. */
export function respondError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  respond(res, status, { type: 'error', code, message });
}

/**
 * Parse a path segment as a positive integer ID.
 * Returns the number or null if invalid.
 */
export function parseId(segment: string | undefined): number | null {
  if (!segment) return null;
  const id = Number(segment);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Parse a query-string value as a positive integer. Returns the number or
 * null if the value is absent, not a finite integer, or not > 0.
 *
 * Narrower than `Number()`: rejects `'1.5'` / `'Infinity'` / `'NaN'` /
 * `'-3'` / empty strings. These values previously reached better-sqlite3
 * as LIMIT / OFFSET bindings and raised `SQLITE_MISMATCH`, which the route
 * handler could only surface as an opaque 500 `internal`. Parse at the
 * boundary so malformed pagination returns a deterministic 400.
 */
export function parsePositiveIntParam(value: string | null): number | null {
  if (value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Read a `code: string` property off an unknown thrown value, treating it as
 * a duck-typed service error. Returns null when the input is not an Error or
 * has no string `code`. Use this to discriminate plugin / repo error codes
 * (e.g. `preset_not_found`, `regenerator_not_attached`) from generic 500s.
 */
export function getErrorCode(err: unknown): string | null {
  if (
    err instanceof Error &&
    'code' in err &&
    typeof (err as Record<string, unknown>).code === 'string'
  ) {
    return (err as { code: string }).code;
  }
  return null;
}

/**
 * Parse JSON from a request body string.
 *
 * Sends 400 response and returns null in two cases:
 * 1. `JSON.parse` throws (malformed input)
 * 2. Parsed value is JSON null — no route accepts a bare `null` body and
 *    returning `null` here would collide with the "response already written"
 *    sentinel, causing callers to `return` without writing a response and
 *    hang the request. Failing at the central parser keeps all
 *    `parseJsonBody(...) === null → return` callsites correct.
 *
 * Callers treat `null` as "response already written; stop". Any non-null
 * return value is a parsed JS value (object / array / number / string /
 * boolean); narrow it with a schema at the callsite.
 */
export function parseJsonBody<T = Record<string, unknown>>(
  res: http.ServerResponse,
  body: string,
): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    respondError(res, 400, 'invalid_json', 'Invalid JSON body');
    return null;
  }
  if (parsed === null) {
    respondError(res, 400, 'invalid_json', 'Request body must not be null');
    return null;
  }
  return parsed as T;
}
