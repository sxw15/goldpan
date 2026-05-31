import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SOURCE_LIST_RESPONSE_KEYS,
  SOURCE_STATUS_COUNTS_KEYS,
} from '../../../../packages/web-sdk/tests/fixtures/sources.fixture.js';
import { request, type StartedServer, startTestServer } from '../helpers';

let server: StartedServer;

beforeAll(async () => {
  server = await startTestServer();
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

describe('GET /sources', () => {
  const authHeaders = () => ({ Authorization: `Bearer ${server.password}` });

  it('requires auth (returns 401 without credentials)', async () => {
    const res = await request(server.port, 'GET', '/sources');
    expect(res.status).toBe(401);
  });

  it('returns 200 with data array (not 400 invalid_id) when no id in path', async () => {
    const res = await request(server.port, 'GET', '/sources', { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('filters by status', async () => {
    const res = await request(server.port, 'GET', '/sources?status=confirmed', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = res.json() as { data: Array<{ status: string }> };
    for (const s of body.data) {
      expect(s.status).toBe('confirmed');
    }
  });

  it('returns 400 invalid_status for unknown status', async () => {
    const res = await request(server.port, 'GET', '/sources?status=bogus', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('invalid_status');
  });

  it('returns 400 invalid_origin for unknown origin', async () => {
    const res = await request(server.port, 'GET', '/sources?origin=mystery', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('invalid_origin');
  });

  it('returns 400 invalid_limit for limit > 200', async () => {
    const res = await request(server.port, 'GET', '/sources?limit=999', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('invalid_limit');
  });

  it('returns 400 invalid_limit for non-numeric limit', async () => {
    const res = await request(server.port, 'GET', '/sources?limit=abc', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
  });

  it('total === data.length (documented semantic)', async () => {
    const res = await request(server.port, 'GET', '/sources?limit=1', {
      headers: authHeaders(),
    });
    const body = res.json() as { data: unknown[]; total: number };
    expect(body.total).toBe(body.data.length);
  });

  it('accepts comma-separated status (confirmed,confirmed_empty)', async () => {
    const res = await request(server.port, 'GET', '/sources?status=confirmed,confirmed_empty', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = res.json() as { data: Array<{ status: string }> };
    for (const s of body.data) {
      expect(['confirmed', 'confirmed_empty']).toContain(s.status);
    }
  });

  it('returns 400 invalid_status when one of the comma-list is bogus', async () => {
    const res = await request(server.port, 'GET', '/sources?status=confirmed,bogus', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('invalid_status');
  });

  it.each([
    'processing',
    'failed',
    'discarded',
  ] as const)('still accepts ?status=%s for debug callers (UI moved off these states but admin curl is preserved)', async (status) => {
    const res = await request(server.port, 'GET', `/sources?status=${status}`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
  });

  it('returns 400 invalid_status when status is empty string (?status=)', async () => {
    const res = await request(server.port, 'GET', '/sources?status=', { headers: authHeaders() });
    expect(res.status).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('invalid_status');
  });

  it('strips trailing/leading commas and whitespace around comma-separated values', async () => {
    const res = await request(
      server.port,
      'GET',
      '/sources?status=%20%2Cconfirmed%20%2C%20failed%2C',
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);
    const body = res.json() as { data: Array<{ status: string }> };
    for (const s of body.data) {
      expect(['confirmed', 'failed']).toContain(s.status);
    }
  });

  it('returns 400 invalid_status when comma list contains only whitespace (?status= , , )', async () => {
    const res = await request(server.port, 'GET', '/sources?status=%20%2C%20%2C%20', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('invalid_status');
  });

  it('response includes counts with all 5 keys (full table-wide counts)', async () => {
    const res = await request(server.port, 'GET', '/sources?status=confirmed', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = res.json() as { counts: Record<string, number> };
    expect(body.counts).toBeDefined();
    for (const k of ['processing', 'confirmed', 'confirmed_empty', 'failed', 'discarded']) {
      expect(typeof body.counts[k]).toBe('number');
    }
  });

  it('response key-set matches SDK SourceListResponse fixture (drift contract)', async () => {
    const res = await request(server.port, 'GET', '/sources', { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(SOURCE_LIST_RESPONSE_KEYS);
    expect(Object.keys(body.counts as object).sort()).toEqual(SOURCE_STATUS_COUNTS_KEYS);
  });
});

describe('GET /sources/:id', () => {
  const authHeaders = () => ({ Authorization: `Bearer ${server.password}` });

  it('returns 400 invalid_id for non-numeric id', async () => {
    const res = await request(server.port, 'GET', '/sources/abc', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('invalid_id');
  });

  it('returns 404 for non-existent id', async () => {
    const res = await request(server.port, 'GET', '/sources/99999', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
    const body = res.json() as { code: string };
    expect(body.code).toBe('not_found');
  });

  it('returns numeric createdAt and updatedAt fields for source detail', async () => {
    const submit = await request(server.port, 'POST', '/submit', {
      headers: authHeaders(),
      body: { input: `source detail timestamp ${Date.now()}` },
    });
    expect(submit.status).toBe(201);
    const submitBody = submit.json() as { taskId: number };

    const task = await request(server.port, 'GET', `/tasks/${submitBody.taskId}`, {
      headers: authHeaders(),
    });
    expect(task.status).toBe(200);
    const taskBody = task.json() as { sourceId: number };

    const res = await request(server.port, 'GET', `/sources/${taskBody.sourceId}`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = res.json() as { source: { createdAt: unknown; updatedAt: unknown } };
    expect(typeof body.source.createdAt).toBe('number');
    expect(typeof body.source.updatedAt).toBe('number');
  });
});
