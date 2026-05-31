import { SERVER_URL } from './server-url';

/**
 * Live "is auth required?" probe — single source of truth lives on the server
 * (`/auth/status` → `authRequired`), not in `process.env.GOLDPAN_AUTH_PASSWORD`.
 *
 * Why not read `process.env` directly: the web process snapshots
 * `GOLDPAN_AUTH_PASSWORD` at boot, but Settings writes go through ConfigStore
 * which updates the *server* process.env at runtime (DB override layer). So
 * any time the user sets / clears the password without restarting web, web's
 * local env is stale. That divergence used to manifest as a redirect loop
 * (`/` → 401 → `/login` → env-empty → `/` → …) and forced the user to
 * "restart web" to escape, which is precisely the kind of friction the
 * runtime-override model was supposed to remove. Asking the server every
 * cache miss puts every web-side auth gate on the same side of the truth as
 * the Bearer check itself.
 *
 * **Fail closed on probe failure (security choice).** A reachable server is
 * required to learn the live answer. When the probe fails (network, 5xx,
 * 404 on a path the server doesn't expose, etc.) we return
 * `{authRequired: true}` and let downstream code redirect to /login. The
 * earlier "fall back to `process.env.GOLDPAN_AUTH_PASSWORD`" path was the
 * exact stale-env decision this probe was created to escape — during a
 * server outage, an admin who just enabled the password through Settings
 * would have web treating requests as no-auth (env empty → false → middleware
 * lets through), exposing protected RSC to anyone hitting the URL during the
 * outage window. Showing the login form when we can't verify is the safer
 * default; the user can refresh once the server is back.
 *
 * **Single-flight dedup.** N concurrent callers on a cold cache (layout +
 * middleware + helper RSCs all firing within ~ms) await a shared in-flight
 * Promise so the server only sees one /auth/status hit. Without this, every
 * Promise.all-style burst doubles or triples the load on the rate-limited
 * unauthenticated bucket.
 *
 * **250ms TTL — short enough to ride out the restart cascade.** A server
 * restart in split-container deploys (only server restarts, web persists)
 * takes ~1–2 s. With a 1 s TTL, a probe answer captured *just before* a
 * restart could be served for ~1 s after the new server came back with the
 * opposite answer (the original "set password → reload → still authRequired
 * false" race, just shortened). 250 ms keeps the cache well inside that
 * restart envelope so the stale window can't span a restart. Burst
 * amortization is handled by single-flight, not TTL — a layout + middleware
 * + N RSCs firing concurrently still see one fetch regardless of TTL.
 *
 * Edge + Node compatible: uses global `fetch` + `AbortSignal.timeout`, no
 * Node-only primitives. Cache is module-local — each runtime (Edge for
 * middleware, Node for RSC / route handlers) gets its own instance, which is
 * fine. Caches don't need to be shared; the truth always converges to the
 * server within 250 ms in both worlds.
 *
 * **No keyed cache.** `SERVER_URL` is captured once at module evaluation
 * (`lib/server-url.ts`). Anything that would invalidate it (rotating env,
 * config change) requires a web restart anyway, which wipes module state
 * including this cache. A `Map<url, entry>` would be defending against a
 * scenario that can't reach this code.
 */
const TTL_MS = 250;
const FETCH_TIMEOUT_MS = 2000;

export interface AuthRequiredProbeResult {
  authRequired: boolean;
}

let cached: { result: AuthRequiredProbeResult; expiresAt: number } | null = null;
let pending: Promise<AuthRequiredProbeResult> | null = null;

async function fetchProbe(): Promise<AuthRequiredProbeResult> {
  try {
    const resp = await fetch(`${SERVER_URL}/auth/status`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return { authRequired: true };
    const body = (await resp.json()) as { authRequired?: unknown };
    // Strict boolean check — anything other than literal `true` (numbers,
    // strings, undefined) collapses to false. The server contract is boolean;
    // strict comparison turns server-side shape drift into a visible "auth not
    // required" decision rather than silent type coercion.
    return { authRequired: body?.authRequired === true };
  } catch {
    return { authRequired: true };
  }
}

export async function probeAuthRequired(): Promise<AuthRequiredProbeResult> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.result;
  if (pending) return pending;

  pending = fetchProbe()
    .then((result) => {
      cached = { result, expiresAt: now + TTL_MS };
      return result;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/**
 * Reset the cached probe state — exported for tests that need deterministic
 * starting state across cases. Throws in production so a `pnpm build` bundle
 * that accidentally references this (e.g. a test util leaking into a
 * production import graph) fails loud instead of silently wiping the cache
 * mid-traffic.
 */
export function __resetAuthProbeCacheForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetAuthProbeCacheForTests is test-only and must not run in production');
  }
  cached = null;
  pending = null;
}
