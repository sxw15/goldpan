import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

import { SERVER_URL } from '@/lib/server-url';
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  LOCALE_MESSAGES,
  type SupportedLocale,
} from './locales';

// One-shot resolution per web Node process. The web process restarts in
// lockstep with the server (`concurrently --kill-others` in dev,
// `start.sh` / docker-compose in prod), so a memoized fetch's lifetime is
// bounded by "until the next deliberate language change forces both
// processes to restart" — the same boundary `dualProcessConfigHash` already
// uses to flag drift. A TTL would only re-fetch on stale data inside one
// process lifetime, which can't happen here.
//
// We cache the *promise* (not the resolved value) so concurrent first-page
// SSR requests share a single round-trip. `Promise.all`-style resolution
// would also work but the single-flight property is cheaper for the SSR hot
// path.
let serverLocaleCache: Promise<SupportedLocale | null> | null = null;

function envLocale(): SupportedLocale {
  const lang = process.env.GOLDPAN_LANGUAGE;
  return isSupportedLocale(lang) ? lang : DEFAULT_LOCALE;
}

async function fetchServerLocale(): Promise<SupportedLocale | null> {
  // 2s caps the SSR latency penalty when the server is mid-restart. Fail
  // open to `null` so callers fall back to envLocale() — better to render
  // in a stale-but-stable locale than block every page on a hung fetch.
  try {
    const r = await fetch(`${SERVER_URL}/runtime-info/effective-env`, {
      signal: AbortSignal.timeout(2000),
      // Server is the source of truth; do NOT let Next.js / undici cache
      // the response inside this process.
      cache: 'no-store',
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { language?: unknown };
    return isSupportedLocale(body.language) ? body.language : null;
  } catch {
    return null;
  }
}

function getServerLocale(): Promise<SupportedLocale | null> {
  if (!serverLocaleCache) {
    serverLocaleCache = fetchServerLocale().then((locale) => {
      // Cache only successful resolutions. A null (server unreachable)
      // result must NOT be cached — wizard restart races would otherwise
      // pin the web process to envLocale() until manual restart.
      if (locale === null) serverLocaleCache = null;
      return locale;
    });
  }
  return serverLocaleCache;
}

/**
 * Test-only hook to reset the module-level cache between cases.
 * `vi.resetModules()` works too but is heavier-handed.
 */
export function _resetLocaleCacheForTests(): void {
  serverLocaleCache = null;
}

export default getRequestConfig(async () => {
  // Resolution order:
  //   1. wizard-locale cookie — set by /onboarding/_actions.ts during the
  //      page-1 language pick. Read-priority because the user is mid-flow
  //      and the server is still in wizard mode (no DB-backed language
  //      override yet).
  //   2. server `/runtime-info/effective-env` — DB-backed runtime override
  //      (or env baseline) reflecting the user's last commit. This is the
  //      source of truth for normal mode; web has no DB connection of its
  //      own so it asks the server.
  //   3. process.env.GOLDPAN_LANGUAGE — last-resort fallback for the
  //      ~100ms window after a wizard restart where the server hasn't
  //      finished bootstrapping yet, plus any deployment that runs web
  //      with no server reachable.
  const cookieJar = await cookies();
  const cookieLocale = cookieJar.get('wizard-locale')?.value;
  if (isSupportedLocale(cookieLocale)) {
    return { locale: cookieLocale, messages: LOCALE_MESSAGES[cookieLocale] };
  }

  const serverLocale = await getServerLocale();
  if (serverLocale) {
    return { locale: serverLocale, messages: LOCALE_MESSAGES[serverLocale] };
  }

  const locale = envLocale();
  return { locale, messages: LOCALE_MESSAGES[locale] };
});
