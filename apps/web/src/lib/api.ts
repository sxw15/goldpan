import type { DigestPreset } from '@goldpan/web-sdk';
import { GoldpanApiError, GoldpanClient } from '@goldpan/web-sdk';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { SESSION_COOKIE } from './auth-edge';
import { probeAuthRequired } from './auth-probe';
import { SERVER_URL } from './server-url';

/**
 * Network-error retry budget shared by every SSR-side GoldpanClient.
 * Covers the restart cascade under `pnpm dev`: `/server/restart` triggers
 * `supervised-start` to kill server + web and respawn both (so dual-process
 * env keys like GOLDPAN_AUTH_PASSWORD get re-read by both processes). New
 * web becomes ready in ~225ms while server's `bootstrap → composeIMRuntime
 * → listen()` takes ~1.6s; the gap is when next-dev's HMR reconnect can
 * race a browser-side reload into a normal-mode middleware that has no
 * live server to probe — and the ECONNREFUSED that lands in SSR there
 * crashes the page.
 *
 * 8 attempts × 400ms linear backoff = 0+400+800+1200+1600+2000+2400+2800
 * = 13.2s budget. Healthy requests succeed on attempt 1 with zero added
 * latency. The defense in `app/error.tsx` — which detects the restart
 * sessionStorage flag and polls /api/health instead of showing a generic
 * error — handles the cases where retry still isn't enough (server boot
 * stretched out, navigation fired before server was ready, etc.) so the
 * user sees "重启中" rather than "出现错误" on the brief race window.
 *
 * Every server-side `new GoldpanClient(...)` MUST pass this so the restart
 * race is handled uniformly — passing nothing leaves a hole that only shows
 * up when a particular page composition lands on the racing client.
 */
const SSR_NETWORK_RETRY = { attempts: 8, baseDelayMs: 400 } as const;

/**
 * Create an authenticated SDK client for server components / server actions.
 * Reads the session cookie from the request and passes it as a Bearer token.
 * On 401 responses, redirects to /login.
 */
export async function createServerClient(): Promise<GoldpanClient> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  return new GoldpanClient({
    baseUrl: SERVER_URL,
    token,
    onUnauthorized: () => {
      redirect('/login');
    },
    retryNetworkErrors: SSR_NETWORK_RETRY,
  });
}

/**
 * Create an unauthenticated SDK client for public endpoints (login, health).
 */
export function createPublicClient(): GoldpanClient {
  return new GoldpanClient({
    baseUrl: SERVER_URL,
    retryNetworkErrors: SSR_NETWORK_RETRY,
  });
}

/**
 * Create a client that surfaces 401 as a thrown `GoldpanApiError` instead of
 * triggering a redirect side-effect. Use when the caller needs to make a
 * decision based on whether the token is still valid (e.g. the login page
 * verifying an existing cookie before short-circuiting).
 */
export function createTokenValidationClient(token: string): GoldpanClient {
  return new GoldpanClient({
    baseUrl: SERVER_URL,
    token,
    retryNetworkErrors: SSR_NETWORK_RETRY,
  });
}

// rethrowNextErrors 实现在 client-safe 的 lib/rethrow（lib/api 用 next/headers，
// client 组件不能直接 import）。这里 re-export 让现有 server callers 路径不变。
export { rethrowNextErrors } from './rethrow';

// SDK has no dedicated subclass for plugin_disabled; centralize the discriminant.
export function isPluginDisabled(err: unknown): err is GoldpanApiError {
  return err instanceof GoldpanApiError && err.status === 503 && err.code === 'plugin_disabled';
}

/**
 * Read the session cookie and decide what to do on the unauthenticated path.
 *
 * Returns one of:
 *  - `string` — valid session token is present; caller passes it to the SDK.
 *  - `undefined` — no token AND auth is not required (open / dev mode); caller
 *    proceeds without a token.
 *  - `'unauthenticated'` — no token AND auth IS required (per live /auth/status
 *    via `probeAuthRequired`); caller short-circuits with its own unauth value
 *    (e.g. `{ kind: 'unauthenticated' }` for the digest helper, `null` for the
 *    search-tool probe). Different shapes are why this helper returns a signal
 *    rather than a final value.
 *
 * Centralizing this avoids the `if (!token) { const {authRequired} = await
 * probeAuthRequired(); if (authRequired) return UNAUTH_VALUE; }` block being
 * duplicated across every cached SDK-call wrapper, where a future fix to the
 * unauth-check semantics would otherwise have to be applied in N places.
 */
export async function readSessionAuth(): Promise<string | undefined | 'unauthenticated'> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) return token;
  const { authRequired } = await probeAuthRequired();
  return authRequired ? 'unauthenticated' : undefined;
}

export function parsePositiveIntField(formData: FormData, field: string): number | null {
  const n = Number(formData.get(field));
  return Number.isInteger(n) && n > 0 ? n : null;
}

export interface ApiErrorMatcher<K extends string = string> {
  status?: number;
  code?: string;
  key: K;
}

// Returns the literal key type from a matcher list — lets callers omit the
// `as 'foo_bar'` cast when forwarding the result to a typed `t()` namespace.
export function pickApiErrorKey<K extends string>(
  err: unknown,
  matchers: ReadonlyArray<ApiErrorMatcher<K>>,
): K | null {
  if (!(err instanceof GoldpanApiError)) return null;
  for (const m of matchers) {
    if (m.status !== undefined && err.status !== m.status) continue;
    if (m.code !== undefined && err.code !== m.code) continue;
    return m.key;
  }
  return null;
}

export type DigestPresetsCached =
  | { kind: 'ok'; presets: DigestPreset[] }
  | { kind: 'plugin_disabled' }
  | { kind: 'unauthenticated' }
  | { kind: 'error'; err: unknown };

/**
 * Cached preset listing shared between the layout's nav-badge probe and the
 * digest page proper. React `cache` keys on args, so both call sites must
 * invoke this same function (not their own `client.listDigestPresets()`) for
 * the dedup to actually fire — otherwise each render burns one extra RPC per
 * page.
 *
 * Returns a discriminated union instead of throwing so the layout can branch
 * to "no badge" without a try/catch and the page can branch to redirect /
 * disabled-view / throw without losing the original error.
 */
export const listDigestPresetsCached = cache(
  async (channel: string): Promise<DigestPresetsCached> => {
    const auth = await readSessionAuth();
    if (auth === 'unauthenticated') return { kind: 'unauthenticated' };
    const client = new GoldpanClient({
      baseUrl: SERVER_URL,
      token: auth,
      retryNetworkErrors: SSR_NETWORK_RETRY,
    });
    try {
      const res = await client.listDigestPresets(channel);
      return { kind: 'ok', presets: res.presets };
    } catch (err) {
      if (err instanceof GoldpanApiError) {
        if (err.status === 503 && err.code === 'plugin_disabled')
          return { kind: 'plugin_disabled' };
        if (err.status === 401) return { kind: 'unauthenticated' };
      }
      return { kind: 'error', err };
    }
  },
);

/**
 * Layout-level nav-badge probe. Reuses the cached preset listing for the
 * default `web` channel; auth failures, network errors, and pre-login screens
 * collapse to `null` so the badge stays hidden rather than flashing a
 * misleading "Off" label.
 */
export async function probeDigestPluginEnabled(): Promise<{ enabled: boolean } | null> {
  const result = await listDigestPresetsCached('web');
  if (result.kind === 'ok') return { enabled: true };
  if (result.kind === 'plugin_disabled') return { enabled: false };
  return null;
}

/**
 * Cached search-tool-configured probe used by the tracking page to render the
 * "尚未配置 Search Tool" warning. Returns `null` instead of throwing so a
 * server outage / unauthenticated render does not collapse the page; in that
 * case the page renders without a warning rather than with a misleading one.
 *
 * `configured: false` is the intentional banner trigger: the registry was
 * reachable AND no plugin exposes a `search` tool. `null` (network / auth
 * failure) deliberately does not trigger the banner — the user still sees
 * the rest of the page and can act on real data once the issue clears.
 */
export const probeSearchToolConfigured = cache(
  async (): Promise<{ configured: boolean } | null> => {
    const auth = await readSessionAuth();
    if (auth === 'unauthenticated') return null;
    const client = new GoldpanClient({
      baseUrl: SERVER_URL,
      token: auth,
      retryNetworkErrors: SSR_NETWORK_RETRY,
    });
    try {
      const status = await client.getSearchToolStatus();
      return { configured: status.configured };
    } catch (err) {
      // Graceful degradation is intentional (banner stays off on auth /
      // network failures so a transient outage doesn't drown the page),
      // but the diagnostic must not vanish — log so deployers can find
      // why the warning is missing when they expected it.
      console.error('[probeSearchToolConfigured] probe failed', err);
      return null;
    }
  },
);
