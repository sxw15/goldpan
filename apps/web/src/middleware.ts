import { type NextRequest, NextResponse } from 'next/server';
import { hasSessionCookie } from '@/lib/auth-edge';
import { probeAuthRequired } from '@/lib/auth-probe';
import { SERVER_URL } from '@/lib/server-url';

// Public API routes that bypass the cookie check.
// - /api/health: documented public probe; proxied to the server's /health.
// - /api/healthz: filesystem route in this web app, used as a process-local
//   liveness probe that does NOT depend on the server. Must stay public so
//   container healthchecks succeed even when GOLDPAN_AUTH_PASSWORD is set.
const PUBLIC_API_PATHS = new Set(['/api/health', '/api/healthz']);

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

export function isAllowedWizardWebHost(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  try {
    const url = new URL(`http://${hostHeader}`);
    return isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function isAllowedWizardOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

export function isAllowedWizardApiRequest(input: {
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
}): boolean {
  if (!isAllowedWizardWebHost(input.host)) return false;
  if (isAllowedWizardOrigin(input.origin)) return true;
  // Same-origin XHR/fetch from a loopback page reaches here with
  // `Origin: null` (same-origin requests in some browsers omit Origin) plus
  // `Sec-Fetch-Site: same-origin`. We do NOT allow `Sec-Fetch-Site: none` —
  // that header value is sent for top-level navigations (address bar,
  // bookmarks), which are GETs that have no business hitting wizard mutating
  // APIs.
  return input.origin === null && input.secFetchSite === 'same-origin';
}

function rejectNonLocalWizardRequest(pathname: string): NextResponse {
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      {
        type: 'error',
        code: 'wizard_forbidden',
        message: 'Wizard mode accepts loopback browser hosts only',
      },
      { status: 403 },
    );
  }
  return new NextResponse('Wizard mode accepts loopback browser hosts only', { status: 403 });
}

// Build a runtime rewrite target for /api/* → ${GOLDPAN_SERVER_URL}/*.
// Resolved per-request so that values injected by docker-compose (e.g. when
// the web container is a separate process from the worker) take effect — the
// previous next.config.ts `rewrites` baked GOLDPAN_SERVER_URL at `next build`
// time and could not be overridden at runtime in standalone output mode.
//
// Implementation note: we set `pathname`/`search` on the parsed serverUrl
// rather than passing a relative path to the URL constructor. Doing
// `new URL('//x', base)` would treat `//x` as a scheme-relative URL and
// hijack the host (e.g. /api//x → http://x/), which is unsafe. Collapsing
// repeated slashes also normalizes the path to a single canonical form.
function rewriteApiToServer(request: NextRequest): NextResponse {
  const target = new URL(SERVER_URL);
  const stripped = request.nextUrl.pathname.replace(/^\/api/, '').replace(/\/{2,}/g, '/');
  target.pathname = stripped || '/';
  target.search = request.nextUrl.search;
  return NextResponse.rewrite(target);
}

interface HealthProbeResult {
  wizardActive: boolean;
}

// Pure server state — what /health said last we asked. Cookie-derived fallback
// lives in the caller (`probeWizardMode`) so the cache stays per-request-agnostic
// and can be safely shared between concurrent callers with different cookies.
// Earlier design folded the cookie fallback INTO this cache, which meant a
// no-cookie request that hit `/health` mid-outage would cache `{wizardActive:
// false}` and any wizard-cookie-bearing request landing within the TTL would
// inherit that wrong answer (the cookie fallback never ran). Splitting fixes
// that without giving up dedup.
type ServerHealthState = { kind: 'live'; wizardActive: boolean } | { kind: 'unreachable' };

// Short TTL preserves one-click-restart UX (wizard → normal becomes visible
// within ~1 s of the restart) while removing the per-request /health RTT that
// every page nav and every poll would otherwise pay.
const PROBE_TTL_MS = 1000;
let cachedHealth: { result: ServerHealthState; expiresAt: number } | null = null;
// Single-flight: concurrent middleware invocations on cold cache await the
// same in-flight promise instead of each issuing their own /health fetch.
// Mirrors the pattern in `lib/auth-probe.ts`.
let pendingHealth: Promise<ServerHealthState> | null = null;

/**
 * Test-only: wipe the module-level cache so successive tests can stub
 * `fetch` to return different `wizardActive` values without each
 * inheriting the previous test's cached probe result. Mirrors
 * `__resetAuthProbeCacheForTests` in `lib/auth-probe.ts`. Throws in
 * production so a stray import doesn't silently clobber the live cache.
 */
export function __resetHealthCacheForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetHealthCacheForTests is test-only and must not run in production');
  }
  cachedHealth = null;
  pendingHealth = null;
}

async function probeServerHealth(): Promise<ServerHealthState> {
  const now = Date.now();
  if (cachedHealth && cachedHealth.expiresAt > now) return cachedHealth.result;
  if (pendingHealth) return pendingHealth;

  const inflight = (async (): Promise<ServerHealthState> => {
    try {
      const probe = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (!probe.ok) return { kind: 'unreachable' };
      const body = (await probe.json()) as { status?: string };
      return { kind: 'live', wizardActive: body?.status === 'wizard' };
    } catch {
      return { kind: 'unreachable' };
    }
  })();
  // Cache + clear pending in chained handlers so concurrent waiters' awaits
  // resume after the cache is populated. `.finally` runs unconditionally
  // so a rejected fetch (shouldn't happen — the IIFE catches all) wouldn't
  // leave pending stuck.
  pendingHealth = inflight
    .then((result) => {
      cachedHealth = { result, expiresAt: Date.now() + PROBE_TTL_MS };
      return result;
    })
    .finally(() => {
      pendingHealth = null;
    });
  return pendingHealth;
}

/**
 * Wizard-mode probe with per-request cookie fallback.
 *
 * On server-unreachable, we'd otherwise flip `wizardActive=false`, collapsing
 * two very different states ("user finished wizard, server restarting" vs
 * "server is genuinely down on a fresh boot") into the same normal-mode
 * branch. The first case races the user: middleware redirects
 * `/onboarding/complete` → `/`, browser SSR fetches the (still-down) server,
 * and the user lands on `error.tsx` instead of the post-restart home.
 *
 * Use the `wizard-locale` cookie as the discriminant — it's set only by
 * `/onboarding/_actions.ts` during the wizard flow and lazily cleared by
 * `clearStaleWizardLocale` on the next successful normal-mode response.
 * Presence here means "this browser was just in the wizard"; assume
 * wizardActive=true for the duration of the outage so /onboarding/* stays
 * mounted.
 *
 * The cookie check is per-request and DOES NOT touch the cache — that's why
 * it lives here and not in `probeServerHealth`. Two concurrent requests with
 * different cookie states correctly diverge: each applies its own fallback
 * against the same cached server-truth.
 */
async function probeWizardMode(request: NextRequest): Promise<HealthProbeResult> {
  const health = await probeServerHealth();
  if (health.kind === 'live') return { wizardActive: health.wizardActive };
  return { wizardActive: request.cookies.has('wizard-locale') };
}

/**
 * Lazy cleanup: if a `wizard-locale` cookie lingers after the wizard has
 * exited, clear it on the next normal-mode response so that the
 * metadata.language lock loaded by core takes precedence over the user's
 * transient page-1 choice. Mutates the response in place and returns it.
 */
function clearStaleWizardLocale(request: NextRequest, response: NextResponse): NextResponse {
  if (request.cookies.has('wizard-locale')) {
    response.cookies.set('wizard-locale', '', { path: '/', maxAge: 0 });
  }
  return response;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const { wizardActive } = await probeWizardMode(request);
  if (wizardActive) {
    if (pathname.startsWith('/api/')) {
      if (
        !isAllowedWizardApiRequest({
          host: request.headers.get('host'),
          origin: request.headers.get('origin'),
          secFetchSite: request.headers.get('sec-fetch-site'),
        })
      ) {
        return rejectNonLocalWizardRequest(pathname);
      }
      // /api/onboarding/* must still rewrite to the wizard server so the
      // onboarding UI can call its endpoints. Skip auth — wizard mode runs
      // unauthenticated by design (localhost-only is the gate).
      if (PUBLIC_API_PATHS.has(pathname)) {
        return pathname === '/api/healthz' ? NextResponse.next() : rewriteApiToServer(request);
      }
      return rewriteApiToServer(request);
    }
    if (!isAllowedWizardWebHost(request.headers.get('host'))) {
      return rejectNonLocalWizardRequest(pathname);
    }
    if (!pathname.startsWith('/onboarding')) {
      return NextResponse.redirect(new URL('/onboarding', request.url));
    }
    // Onboarding pages pass through (no auth in wizard mode).
    const reqHeaders = new Headers(request.headers);
    reqHeaders.set('x-pathname', pathname);
    return NextResponse.next({ request: { headers: reqHeaders } });
  }

  // ── Normal mode (existing logic) ──
  // /onboarding/* is wizard-only — its state API only exists on the wizard
  // server, so in normal mode the page would render an empty skeleton with a
  // "failed to load wizard state" banner. Send users back home instead.
  if (pathname.startsWith('/onboarding')) {
    return clearStaleWizardLocale(request, NextResponse.redirect(new URL('/', request.url)));
  }

  if (pathname.startsWith('/login')) {
    // Forward pathname so RootLayout can recognise /login and suppress the
    // authed-shell chrome (TopNav, Logout). Without this header, layout falls
    // through to the normal-shell branch and a stale session cookie alone
    // causes the nav links to render on top of the login form — clicking any
    // of them then bounces back to /login on 401.
    const reqHeaders = new Headers(request.headers);
    reqHeaders.set('x-pathname', pathname);
    return clearStaleWizardLocale(request, NextResponse.next({ request: { headers: reqHeaders } }));
  }

  // Public HMAC-gated route: bypass cookie redirect — auth happens via the
  // `sig` query param at /digest/share/:id (see apps/server/src/routes/digest.ts).
  if (pathname.startsWith('/digest/share/')) {
    const reqHeaders = new Headers(request.headers);
    reqHeaders.set('x-pathname', pathname);
    return clearStaleWizardLocale(request, NextResponse.next({ request: { headers: reqHeaders } }));
  }

  if (pathname.startsWith('/api/')) {
    // Public API endpoints: skip the cookie check (see PUBLIC_API_PATHS doc).
    if (PUBLIC_API_PATHS.has(pathname)) {
      return clearStaleWizardLocale(
        request,
        pathname === '/api/healthz' ? NextResponse.next() : rewriteApiToServer(request),
      );
    }

    // Defense-in-depth cookie check at the edge before forwarding to the server
    // (the server enforces its own Bearer-token auth as the source of truth).
    // Source of truth for "is auth required?" is the server via probeAuthRequired —
    // see lib/auth-probe.ts for why we don't read process.env directly.
    const { authRequired: apiAuthRequired } = await probeAuthRequired();
    if (apiAuthRequired) {
      const cookieHeader = request.headers.get('cookie');
      if (!hasSessionCookie(cookieHeader)) {
        return clearStaleWizardLocale(
          request,
          NextResponse.json(
            { type: 'error', code: 'unauthorized', message: 'Unauthorized' },
            { status: 401 },
          ),
        );
      }
    }

    return clearStaleWizardLocale(request, rewriteApiToServer(request));
  }

  const { authRequired } = await probeAuthRequired();
  if (!authRequired) {
    const reqHeaders = new Headers(request.headers);
    reqHeaders.set('x-pathname', pathname);
    return clearStaleWizardLocale(request, NextResponse.next({ request: { headers: reqHeaders } }));
  }

  const cookieHeader = request.headers.get('cookie');
  if (!hasSessionCookie(cookieHeader)) {
    const loginUrl = new URL('/login', request.url);
    return clearStaleWizardLocale(request, NextResponse.redirect(loginUrl));
  }

  const reqHeaders = new Headers(request.headers);
  reqHeaders.set('x-pathname', pathname);
  return clearStaleWizardLocale(request, NextResponse.next({ request: { headers: reqHeaders } }));
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
