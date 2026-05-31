import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { __resetAuthProbeCacheForTests, probeAuthRequired } from './auth-probe';

// Probe behavior matters because it sits in front of every middleware
// auth decision + every server component auth gate. Regressions silently
// flip the answer from "ask the server" back to "trust web's stale env",
// which is exactly the redirect-loop bug this module was created to kill.

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_SERVER_URL = process.env.GOLDPAN_SERVER_URL;
const ORIGINAL_AUTH_PASSWORD = process.env.GOLDPAN_AUTH_PASSWORD;

beforeEach(() => {
  __resetAuthProbeCacheForTests();
  // Note: SERVER_URL is module-evaluated once at import time, so the cache
  // key won't reflect runtime mutations of this env. The tests verify the
  // fetch URL via mock inspection rather than relying on a re-keyed cache.
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_SERVER_URL === undefined) delete process.env.GOLDPAN_SERVER_URL;
  else process.env.GOLDPAN_SERVER_URL = ORIGINAL_SERVER_URL;
  if (ORIGINAL_AUTH_PASSWORD === undefined) delete process.env.GOLDPAN_AUTH_PASSWORD;
  else process.env.GOLDPAN_AUTH_PASSWORD = ORIGINAL_AUTH_PASSWORD;
});

function mockFetchOk(body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok: true,
    json: async () => body,
  }));
  global.fetch = fn as unknown as typeof global.fetch;
  return fn;
}

describe('probeAuthRequired', () => {
  test('reads authRequired from server /auth/status', async () => {
    mockFetchOk({ authRequired: true });
    const result = await probeAuthRequired();
    expect(result).toEqual({ authRequired: true });
  });

  test('treats missing authRequired field as false (strict boolean check)', async () => {
    mockFetchOk({});
    const result = await probeAuthRequired();
    expect(result).toEqual({ authRequired: false });
  });

  test('treats non-boolean truthy authRequired as false (strict ===)', async () => {
    // Server contract is boolean; coerced/string responses must NOT silently
    // pass the `=== true` gate. This guards against server-side shape drift.
    mockFetchOk({ authRequired: 'true' });
    const result = await probeAuthRequired();
    expect(result).toEqual({ authRequired: false });
  });

  test('caches successful response within TTL — no second fetch', async () => {
    const fetchFn = mockFetchOk({ authRequired: true });
    await probeAuthRequired();
    await probeAuthRequired();
    await probeAuthRequired();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('single-flight: concurrent cold-cache callers share one fetch', async () => {
    // Without dedup, every Promise.all-style burst (layout + helper RSCs)
    // would multiply the load on the rate-limited unauthenticated bucket.
    let resolveFetch!: (v: { ok: true; json: () => Promise<unknown> }) => void;
    const fetchFn = vi.fn(
      () =>
        new Promise((r) => {
          resolveFetch = r;
        }),
    );
    global.fetch = fetchFn as unknown as typeof global.fetch;

    const p1 = probeAuthRequired();
    const p2 = probeAuthRequired();
    const p3 = probeAuthRequired();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: true, json: async () => ({ authRequired: true }) });
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toEqual({ authRequired: true });
    expect(r2).toEqual({ authRequired: true });
    expect(r3).toEqual({ authRequired: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('on non-2xx response: fails closed (authRequired=true) and caches', async () => {
    // Cache failure too — without it, every RSC in a burst pays the probe
    // round-trip during a brief 5xx window and the cache writes never settle.
    const fetchFn = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    global.fetch = fetchFn as unknown as typeof global.fetch;

    const r1 = await probeAuthRequired();
    expect(r1).toEqual({ authRequired: true }); // fail-closed

    const r2 = await probeAuthRequired();
    expect(r2).toEqual({ authRequired: true });
    expect(fetchFn).toHaveBeenCalledTimes(1); // 2nd call hit cache
  });

  test('on fetch rejection: fails closed regardless of env', async () => {
    // Earlier behavior fell back to !!process.env.GOLDPAN_AUTH_PASSWORD,
    // which reintroduced the exact stale-env decision the probe escapes —
    // an outage while the user has just enabled the password through
    // Settings would have web treating requests as no-auth (env empty →
    // false) and exposing protected RSC. Fail-closed prevents that.
    process.env.GOLDPAN_AUTH_PASSWORD = 'pw';
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof global.fetch;

    const result = await probeAuthRequired();
    expect(result).toEqual({ authRequired: true });
  });

  test('on fetch rejection: fails closed even when env is empty', async () => {
    delete process.env.GOLDPAN_AUTH_PASSWORD;
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof global.fetch;

    const result = await probeAuthRequired();
    expect(result).toEqual({ authRequired: true });
  });

  test('on malformed JSON response: fails closed', async () => {
    // resp.json() throwing surfaces as a thrown exception in fetchProbe,
    // which the catch-all turns into fail-closed.
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    }));
    global.fetch = fetchFn as unknown as typeof global.fetch;

    const result = await probeAuthRequired();
    expect(result).toEqual({ authRequired: true });
  });

  test('on 404 (wizard mode where /auth/status is not mounted): fails closed and caches', async () => {
    // wizard-server only handles /health; a probe in normal mode that races
    // with a wizard reboot would receive 404. Treating it as fail-closed
    // + cached avoids hammering the server during the wizard window.
    const fetchFn = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    global.fetch = fetchFn as unknown as typeof global.fetch;

    const r1 = await probeAuthRequired();
    const r2 = await probeAuthRequired();
    expect(r1).toEqual({ authRequired: true });
    expect(r2).toEqual({ authRequired: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('calls server /auth/status at the configured server URL', async () => {
    const fetchFn = mockFetchOk({ authRequired: false });
    await probeAuthRequired();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const callUrl = fetchFn.mock.calls[0]?.[0];
    expect(typeof callUrl).toBe('string');
    expect(callUrl as string).toMatch(/\/auth\/status$/);
  });
});
