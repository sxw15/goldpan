import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// Mock probes BEFORE importing middleware so the module-level cache doesn't
// trigger real network calls in the jsdom env. The /login branch we test
// below executes in normal mode (wizardActive=false) and skips authRequired.
vi.mock('@/lib/auth-probe', () => ({
  probeAuthRequired: vi.fn(async () => ({ authRequired: false })),
}));
vi.mock('@/lib/server-url', () => ({
  SERVER_URL: 'http://localhost:0/__test_unused__',
}));
vi.stubGlobal(
  'fetch',
  // probeServerHealth() in middleware uses fetch — return a non-wizard
  // health snapshot so the normal-mode branch runs.
  vi.fn(
    async () =>
      new Response(JSON.stringify({ wizardActive: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ),
);

import {
  __resetHealthCacheForTests,
  isAllowedWizardApiRequest,
  isAllowedWizardWebHost,
  middleware,
} from './middleware';

beforeEach(() => {
  // Clear module-level health cache so each test stubs from a clean slate;
  // PROBE_TTL_MS=1000ms is short enough that successive tests in the same
  // file otherwise read each other's cached result. Mirrors the pattern
  // in `lib/auth-probe.ts:__resetAuthProbeCacheForTests`.
  __resetHealthCacheForTests();
});

describe('wizard middleware host gate', () => {
  test('allows loopback browser hosts', () => {
    expect(isAllowedWizardWebHost('localhost:3000')).toBe(true);
    expect(isAllowedWizardWebHost('127.0.0.1:3000')).toBe(true);
    expect(isAllowedWizardWebHost('[::1]:3000')).toBe(true);
  });

  test('rejects public or missing hosts', () => {
    expect(isAllowedWizardWebHost('goldpan.example.com')).toBe(false);
    expect(isAllowedWizardWebHost('192.168.1.10:3000')).toBe(false);
    expect(isAllowedWizardWebHost(null)).toBe(false);
  });

  test('rejects Host-spoofed API requests that lack browser same-origin evidence', () => {
    expect(
      isAllowedWizardApiRequest({
        host: 'localhost:3000',
        origin: null,
        secFetchSite: null,
      }),
    ).toBe(false);
  });

  test('allows loopback same-origin browser API requests', () => {
    expect(
      isAllowedWizardApiRequest({
        host: 'localhost:3000',
        origin: null,
        secFetchSite: 'same-origin',
      }),
    ).toBe(true);
    expect(
      isAllowedWizardApiRequest({
        host: 'localhost:3000',
        origin: 'http://localhost:3000',
        secFetchSite: null,
      }),
    ).toBe(true);
  });

  test('rejects Sec-Fetch-Site: none (top-level navigation, not an API call)', () => {
    expect(
      isAllowedWizardApiRequest({
        host: 'localhost:3000',
        origin: null,
        secFetchSite: 'none',
      }),
    ).toBe(false);
  });
});

describe('middleware /login path injects x-pathname (Important.7)', () => {
  test('/login response forwards x-pathname so layout can suppress nav', async () => {
    // Without this header, RootLayout falls through to the authenticated
    // shell branch (TopNav + Logout) on `/login`, producing a confusing
    // "logged-in looking" page that 401-bounces on every nav click.
    const req = new NextRequest(new URL('http://localhost:3000/login'));
    const res = await middleware(req);
    // NextResponse.next({request: {headers}}) preserves the forwarded
    // headers as `x-middleware-request-*` on the outgoing response so
    // the downstream RSC can read them via headers().
    const forwarded = res.headers.get('x-middleware-request-x-pathname');
    expect(forwarded).toBe('/login');
  });

  test('non-/login normal-mode route still gets x-pathname', async () => {
    // Sanity check: the same forwarding contract holds on / and /settings;
    // this test guards against an accidental selective deletion of the
    // header injection that only kept it on one branch.
    const req = new NextRequest(new URL('http://localhost:3000/settings'));
    const res = await middleware(req);
    expect(res.headers.get('x-middleware-request-x-pathname')).toBe('/settings');
  });
});

describe('middleware wizard-mode branching', () => {
  // The host-gate helpers above test the gating functions in isolation, but
  // they don't exercise the middleware() entry point's wizard branch —
  // mutations that disable wizard mode (e.g. removing the
  // `if (wizardActive)` block) would still pass the helper-level tests.
  // These cases drive middleware() with the /health probe returning
  // `status: 'wizard'` so the wizard branch is the one under test.

  test('wizard-active + non-loopback host → 403 (host gate denies)', async () => {
    // Stub fetch to return `status: 'wizard'` exactly for this case so
    // the wizard branch fires. The stub is scoped to one call by replacing
    // the global fetch impl, then restored implicitly by the next test's
    // beforeEach cache reset (which means the next fetch reads from the
    // original `vi.stubGlobal` registration above this describe block).
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'wizard' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    try {
      const req = new NextRequest(new URL('http://goldpan.example.com/onboarding'), {
        headers: { host: 'goldpan.example.com' },
      });
      const res = await middleware(req);
      expect(res.status).toBe(403);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('wizard-active + loopback host + non-onboarding path → redirect to /onboarding', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'wizard' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    try {
      const req = new NextRequest(new URL('http://localhost:3000/settings'), {
        headers: { host: 'localhost:3000' },
      });
      const res = await middleware(req);
      // NextResponse.redirect returns a 307; the Location header carries
      // the wizard URL so the browser bounces into the onboarding flow.
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('/onboarding');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
