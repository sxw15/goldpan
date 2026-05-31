// apps/server/tests/routes/runtime-info.test.ts
//
// Web (separate Next.js process) calls `/runtime-info/effective-env` from
// server components to recover the effective UI locale + timezone after a
// wizard restart. This integration test pins the wire contract: the public
// JSON body MUST include both `language` and `timezone`, and `timezone` MUST
// reflect the live config (DB override > env baseline > host-detected
// default). Authentication is intentionally skipped on this endpoint so the
// login page can render in the user's locale + timezone before the password
// gate.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request, type StartedServer, startTestServer } from '../helpers';

describe('GET /runtime-info/effective-env (timezone)', () => {
  let server: StartedServer;

  beforeAll(async () => {
    server = await startTestServer({
      envOverrides: { GOLDPAN_TIMEZONE: 'Asia/Tokyo' },
    });
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('returns the live timezone alongside language without auth', async () => {
    const res = await request(server.port, 'GET', '/runtime-info/effective-env');
    expect(res.status).toBe(200);
    const body = res.json() as { language?: unknown; timezone?: unknown };
    expect(body.language).toBe('en');
    expect(body.timezone).toBe('Asia/Tokyo');
  });
});
