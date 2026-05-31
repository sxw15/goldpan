// apps/server/tests/rate-limit.test.ts
//
// Regression: a single web user normally generates many GETs per page render
// (SSR + browser /api/* rewrite both terminate at the Next.js process, so the
// server sees one shared loopback IP). The 30/min global cap was tripping on
// legitimate authenticated traffic. The contract this file pins down:
//   - Authenticated requests bypass the rate limiter entirely.
//   - Failed/missing auth still counts toward the IP bucket so the
//     brute-force protection on /auth/login and on Bearer-token guessing
//     (across any method) is preserved.
//
// Lives in its own file so the bucket exhaustion in the brute-force test
// cannot bleed into routes.test.ts (each test file spawns its own server).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RATE_MAX_REQUESTS } from '../src/rate-limit.js';
import { request, type StartedServer, startTestServer } from './helpers';

let server: StartedServer;

beforeAll(async () => {
  server = await startTestServer();
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

describe('Rate limiting', () => {
  it('does not rate-limit authenticated traffic past the global cap', async () => {
    // 50 authenticated GETs in a tight loop; before the fix this would 429 on
    // request 31 (when the cap was 30). We assert all 50 succeed and the
    // bucket stays untouched. 50 is well below the current cap so the test
    // doesn't need to scale with future limit bumps.
    const auth = { Authorization: `Bearer ${server.password}` };
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => request(server.port, 'GET', '/tasks', { headers: auth })),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
    }
  });

  it('rate-limits invalid Bearer brute-force on protected routes by IP', async () => {
    // Sequential — the first RATE_MAX_REQUESTS attempts pass the rate-limit
    // gate and are rejected by auth (401); the next one trips the global
    // limiter (429). This pins down the brute-force protection from the
    // comment in main.ts: a failed-auth Bearer attempt on ANY method still
    // counts toward the bucket. /auth/login is intentionally NOT used here
    // because it has its own tighter 5/min login-specific limiter
    // (routes/auth.ts). `RATE_MAX_REQUESTS` is imported from the source so
    // future cap changes don't require a manual sync of this test.
    const wrongAuth = { Authorization: 'Bearer not-the-real-password' };
    const seen: number[] = [];
    for (let i = 0; i < RATE_MAX_REQUESTS + 1; i += 1) {
      const res = await request(server.port, 'GET', '/tasks', { headers: wrongAuth });
      seen.push(res.status);
    }
    expect(seen.slice(0, RATE_MAX_REQUESTS).every((s) => s === 401)).toBe(true);
    expect(seen[RATE_MAX_REQUESTS]).toBe(429);
  });

  it('still serves authenticated requests after the anonymous bucket is full', async () => {
    // The previous test exhausted the IP bucket. An authenticated GET in the
    // same window must still succeed — proving the bypass is per-request, not
    // a side-effect of an empty bucket.
    const res = await request(server.port, 'GET', '/tasks', {
      headers: { Authorization: `Bearer ${server.password}` },
    });
    expect(res.status).toBe(200);
  });
});
