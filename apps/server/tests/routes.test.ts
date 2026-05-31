// apps/server/tests/routes.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request, type StartedServer, startTestServer } from './helpers';

let server: StartedServer;

// Each suite gets its own isolated server; the 60s timeout covers
// bootstrap (DB + plugins + worker) on a cold CI runner.
beforeAll(async () => {
  server = await startTestServer();
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

describe('Server API routes', () => {
  const authHeaders = () => ({ Authorization: `Bearer ${server.password}` });

  describe('GET /health', () => {
    it('returns 200 with status ok and worker/channels info', async () => {
      const res = await request(server.port, 'GET', '/health');
      expect(res.status).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.status).toBe('ok');
      expect(body.worker).toEqual({ running: true });
      expect(Array.isArray(body.channels)).toBe(true);
    });
  });

  describe('GET /runtime-info/effective-env', () => {
    // Web (separate Next.js process) calls this so its i18n loader and tz
    // provider can recover the effective UI locale + timezone without
    // depending on a process.env that the wizard's DB-only commit never wrote
    // into. Authentication is intentionally skipped: the login page itself
    // needs the locale + tz, and both are non-sensitive — no other
    // dual-process keys are returned. Timezone-specific assertions live in
    // tests/routes/runtime-info.test.ts where envOverrides pin a known tz.
    it('returns the configured language and timezone without auth', async () => {
      const res = await request(server.port, 'GET', '/runtime-info/effective-env');
      expect(res.status).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.language).toBe('en');
      expect(typeof body.timezone).toBe('string');
      expect((body.timezone as string).length).toBeGreaterThan(0);
    });
  });

  describe('Auth routes', () => {
    it('GET /auth/status returns auth info with features and config', async () => {
      const res = await request(server.port, 'GET', '/auth/status');
      expect(res.status).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('authenticated');
      expect(body).toHaveProperty('authRequired');
      expect(body).toHaveProperty('language');
      expect(body).toHaveProperty('features');
      expect(body).toHaveProperty('config');
      const features = body.features as Record<string, unknown>;
      expect(features).toHaveProperty('embedding');
      expect(features).toHaveProperty('relations');
      expect(features).toHaveProperty('debug');
      const config = body.config as Record<string, unknown>;
      expect(config).toHaveProperty('maxTextInputLength');
    });

    it('GET /auth/status with valid Bearer password reports authenticated=true', async () => {
      // Regression guard for the /auth/status vs protected-route consistency fix.
      const res = await request(server.port, 'GET', '/auth/status', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.authenticated).toBe(true);
    });

    it('GET /auth/status with no credentials reports authenticated=false', async () => {
      const res = await request(server.port, 'GET', '/auth/status');
      expect(res.status).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body.authenticated).toBe(false);
    });

    it('POST /auth/login with wrong password returns 401', async () => {
      const res = await request(server.port, 'POST', '/auth/login', {
        body: { password: 'wrong-password' },
      });
      expect(res.status).toBe(401);
    });

    it('POST /auth/login with correct password returns 200 + cookie', async () => {
      const res = await request(server.port, 'POST', '/auth/login', {
        body: { password: server.password },
      });
      expect(res.status).toBe(200);
      expect(res.headers['set-cookie']).toBeDefined();
      const body = res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('token');
      expect(body).toHaveProperty('expiresAt');
    });
  });

  describe('Task routes', () => {
    it('GET /tasks without auth returns 401', async () => {
      // Protected GET routes must now require auth (same model as POST).
      const res = await request(server.port, 'GET', '/tasks');
      expect(res.status).toBe(401);
    });

    it('GET /tasks returns task list', async () => {
      const res = await request(server.port, 'GET', '/tasks', { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('GET /tasks/999999 returns 404', async () => {
      const res = await request(server.port, 'GET', '/tasks/999999', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it('GET /tasks/abc returns 400', async () => {
      const res = await request(server.port, 'GET', '/tasks/abc', { headers: authHeaders() });
      expect(res.status).toBe(400);
    });
  });

  describe('Knowledge routes', () => {
    it('GET /categories returns category list with total', async () => {
      const res = await request(server.port, 'GET', '/categories', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
    });

    it('GET /entities returns entity list with total', async () => {
      const res = await request(server.port, 'GET', '/entities', { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
    });

    it('GET /entities/999999 returns 404', async () => {
      const res = await request(server.port, 'GET', '/entities/999999', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it('GET /entities?name=... returns name→id lookup map', async () => {
      // This subprocess-style route test cannot seed repos directly, so it
      // checks routing + response shape with a non-existent name. The matched
      // entity behavior is covered by KnowledgeRepository tests.
      const res = await request(server.port, 'GET', '/entities?name=nonexistent', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = res.json() as { data: Record<string, number> };
      expect(body.data).toEqual({});
    });

    it('GET /entities?name=A&name=B returns lookup shape without total', async () => {
      const res = await request(server.port, 'GET', '/entities?name=foo&name=bar&name=baz', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = res.json() as { data: Record<string, number> };
      expect(typeof body.data).toBe('object');
      expect(body).not.toHaveProperty('total');
    });

    it('GET /entities?name= (empty value) returns empty map', async () => {
      const res = await request(server.port, 'GET', '/entities?name=', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = res.json() as { data: Record<string, number> };
      expect(body.data).toEqual({});
    });

    it('GET /entities?names= legacy comma param remains supported', async () => {
      const res = await request(server.port, 'GET', '/entities?names=foo,bar', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = res.json() as { data: Record<string, number> };
      expect(typeof body.data).toBe('object');
      expect(body).not.toHaveProperty('total');
    });
  });

  describe('Note routes', () => {
    it('GET /notes returns source-view list with total, categories, stats', async () => {
      const res = await request(server.port, 'GET', '/notes', { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('total');
      expect(body).toHaveProperty('categories');
      expect(body).toHaveProperty('stats');
      const stats = body.stats as Record<string, unknown>;
      expect(stats).toHaveProperty('sourceCount');
      expect(stats).toHaveProperty('noteCount');
      expect(stats.noteCount).toBe(stats.sourceCount);
    });

    it('GET /notes/999999 returns 404', async () => {
      const res = await request(server.port, 'GET', '/notes/999999', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('Unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      // /nonexistent is not under /auth/*, so it goes through the auth gate
      // when a password is set. With a valid bearer token it falls through
      // to the not-found handler.
      const res = await request(server.port, 'GET', '/nonexistent', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('Github routes', () => {
    it('POST /github/refresh without auth returns 401', async () => {
      const res = await request(server.port, 'POST', '/github/refresh', {
        body: { owner: 'anthropics', repo: 'claude-code' },
      });
      expect(res.status).toBe(401);
    });

    it('POST /github/refresh with missing owner returns 400 invalid_input', async () => {
      const res = await request(server.port, 'POST', '/github/refresh', {
        body: { repo: 'claude-code' },
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);
      const body = res.json() as Record<string, unknown>;
      expect(body.code).toBe('invalid_input');
    });

    it('POST /github/refresh with invalid JSON returns 400 invalid_json', async () => {
      // Bypass `request()` to send a raw non-JSON body.
      const raw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = require('node:http').request(
          {
            hostname: '127.0.0.1',
            port: server.port,
            method: 'POST',
            path: '/github/refresh',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${server.password}`,
            },
          },
          (r: any) => {
            const chunks: Buffer[] = [];
            r.on('data', (c: Buffer) => chunks.push(c));
            r.on('end', () =>
              resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf-8') }),
            );
          },
        );
        req.on('error', reject);
        req.write('not-json');
        req.end();
      });
      expect(raw.status).toBe(400);
      expect(JSON.parse(raw.body).code).toBe('invalid_json');
    });

    // F1 regression: body `null` parses successfully to `null` but no route
    // accepts a bare null. Pre-fix, destructure of `payload.owner` on null
    // threw outside the try/catch → top-level handler → 500 `internal`. Central
    // parseJsonBody now rejects null body up front with 400 invalid_json.
    it('POST /github/refresh with body "null" returns 400 invalid_json', async () => {
      const raw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = require('node:http').request(
          {
            hostname: '127.0.0.1',
            port: server.port,
            method: 'POST',
            path: '/github/refresh',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${server.password}`,
            },
          },
          (r: any) => {
            const chunks: Buffer[] = [];
            r.on('data', (c: Buffer) => chunks.push(c));
            r.on('end', () =>
              resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf-8') }),
            );
          },
        );
        req.on('error', reject);
        req.write('null');
        req.end();
      });
      expect(raw.status).toBe(400);
      expect(JSON.parse(raw.body).code).toBe('invalid_json');
    });

    it('POST /github/refresh-by-url with body "null" returns 400 invalid_json', async () => {
      const raw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = require('node:http').request(
          {
            hostname: '127.0.0.1',
            port: server.port,
            method: 'POST',
            path: '/github/refresh-by-url',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${server.password}`,
            },
          },
          (r: any) => {
            const chunks: Buffer[] = [];
            r.on('data', (c: Buffer) => chunks.push(c));
            r.on('end', () =>
              resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf-8') }),
            );
          },
        );
        req.on('error', reject);
        req.write('null');
        req.end();
      });
      expect(raw.status).toBe(400);
      expect(JSON.parse(raw.body).code).toBe('invalid_json');
    });

    it('POST /github/refresh-by-url with missing normalizedUrl returns 400 invalid_input', async () => {
      const res = await request(server.port, 'POST', '/github/refresh-by-url', {
        body: {},
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);
      const body = res.json() as Record<string, unknown>;
      expect(body.code).toBe('invalid_input');
    });

    it('GET /github/state without owner/repo returns 400 invalid_input', async () => {
      const res = await request(server.port, 'GET', '/github/state', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);
      const body = res.json() as Record<string, unknown>;
      expect(body.code).toBe('invalid_input');
    });

    it('GET /github/state returns 200 and { data: null } for a never-seen repo', async () => {
      const res = await request(server.port, 'GET', '/github/state?owner=owner-xyz&repo=repo-xyz', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('data');
    });

    it('GET /github/unknown returns 404', async () => {
      const res = await request(server.port, 'GET', '/github/unknown', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
      const body = res.json() as Record<string, unknown>;
      expect(body.code).toBe('not_found');
    });
  });

  describe('Github EntityDetail enrichment', () => {
    it('returns githubRepo: null (or absent) for entities without a github source', async () => {
      const listed = await request(server.port, 'GET', '/entities', { headers: authHeaders() });
      expect(listed.status).toBe(200);
      const listBody = listed.json() as { data: Array<{ id: number }> };
      if (listBody.data.length === 0) return; // nothing to assert against on a fresh DB
      const firstId = listBody.data[0].id;
      const detail = await request(server.port, 'GET', `/entities/${firstId}`, {
        headers: authHeaders(),
      });
      expect(detail.status).toBe(200);
      const body = detail.json() as Record<string, unknown>;
      expect(body).toHaveProperty('entity');
      expect(body).toHaveProperty('points');
      expect(body).toHaveProperty('sources');
      expect(body).toHaveProperty('relations');
      // githubRepo is optional — assert only that when present it is null on a non-github entity.
      if ('githubRepo' in body) {
        expect(body.githubRepo).toBeNull();
      }
    });
  });
});
