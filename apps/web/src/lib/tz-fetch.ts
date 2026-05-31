import 'server-only';
import { SERVER_URL } from './server-url';

/**
 * SSR fetch of effective timezone from server's /runtime-info/effective-env.
 * Mirrors apps/web/src/i18n/request.ts pattern:
 *   - Module-level promise cache (single-flight, no TTL needed because the
 *     web process restarts in lockstep with server on commits affecting boot)
 *   - 2s timeout to cap SSR latency penalty when server mid-restart
 *   - Fail open to envTimezone() (process.env baseline from dotenv) so a
 *     server-unreachable window doesn't pin the web process to fallback
 *     across restarts
 */

let cache: Promise<string | null> | null = null;

function envTimezone(): string {
  return process.env.GOLDPAN_TIMEZONE || 'UTC';
}

async function fetchOnce(): Promise<string | null> {
  try {
    const r = await fetch(`${SERVER_URL}/runtime-info/effective-env`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { timezone?: unknown };
    if (typeof body.timezone === 'string' && body.timezone.length > 0) return body.timezone;
    return null;
  } catch {
    return null;
  }
}

export async function getEffectiveTimezone(): Promise<string> {
  if (!cache) {
    cache = fetchOnce().then((tz) => {
      // Don't pin to fallback during restart races — null result must NOT be cached.
      if (tz === null) cache = null;
      return tz;
    });
  }
  const live = await cache;
  return live ?? envTimezone();
}

/** Test-only hook to reset the cache between cases. */
export function _resetTzCacheForTests(): void {
  cache = null;
}
