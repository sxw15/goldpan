// apps/server/tests/routes/tracking.test.ts
//
// Integration test suite for the /tracking/* HTTP routes. Uses the same
// `startTestServer` helper as sources.test.ts / digest.test.ts, spawning a
// real subprocess with an isolated SQLite DB so the routes exercise the
// plugin layer end-to-end (HTTP request → route handler → plugin service →
// DB row).
//
// T3/T4 — this test locks the Interest-rename response shape against the
// canonical fixture in `packages/web-sdk/tests/fixtures/interest.fixture.ts`,
// the single source of truth for the three-side duck-typing contract
// (plugin TS / server route JSON / SDK TS). Relative path kept off the
// package.json `exports` so fixture does not leak into the SDK dist bundle.
import path from 'node:path';
import { NOW_MS_SQL } from '@goldpan/core/db/sql-fragments';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INTEREST_DETAIL_KEYS,
  INTEREST_EXECUTION_DETAIL_KEYS,
  INTEREST_EXECUTION_KEYS,
  INTEREST_ITEM_KEYS,
  INTEREST_KEYS,
  INTEREST_LINKED_ENTITY_KEYS,
  INTEREST_LIST_ITEM_KEYS,
} from '../../../../packages/web-sdk/tests/fixtures/interest.fixture';
import { request, type StartedServer, startTestServer } from '../helpers';

describe('/tracking routes — list + create (shared server)', () => {
  let server: StartedServer;

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  const authHeaders = () => ({ Authorization: `Bearer ${server.password}` });

  describe('GET /tracking/rules', () => {
    it('requires auth (returns 401 without credentials)', async () => {
      const res = await request(server.port, 'GET', '/tracking/rules');
      expect(res.status).toBe(401);
    });

    it('returns empty list when no interests exist', async () => {
      const res = await request(server.port, 'GET', '/tracking/rules', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = res.json() as { data: unknown[]; total: number };
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('GET /tracking/rules without id returns 200 list (not 400 invalid_id)', async () => {
      // parseId 陷阱：顶层不应对空 id 做 parseId，否则 GET /tracking/rules 会被
      // 误判为 invalid_id 400。
      const res = await request(server.port, 'GET', '/tracking/rules', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /tracking/rules', () => {
    it('creates with searchQueries + returns 201 + shape key-set == INTEREST_KEYS', async () => {
      const res = await request(server.port, 'POST', '/tracking/rules', {
        headers: authHeaders(),
        body: { name: 'CreateTest', searchQueries: ['foo', 'bar'] },
      });
      expect(res.status).toBe(201);
      const body = res.json() as { data: Record<string, unknown> };
      expect(body.data).toMatchObject({
        name: 'CreateTest',
        searchQueries: ['foo', 'bar'],
        linkedEntityIds: [],
        enabled: true,
      });
      // Key-set assertion locks the three-side Interest shape contract.
      expect(Object.keys(body.data).sort()).toEqual(INTEREST_KEYS);
    });

    it('400 validation_error on missing searchQueries', async () => {
      const res = await request(server.port, 'POST', '/tracking/rules', {
        headers: authHeaders(),
        body: { name: 'NoQueries' },
      });
      expect(res.status).toBe(400);
      const body = res.json() as { code: string };
      expect(body.code).toBe('validation_error');
    });

    it('400 validation_error on missing name', async () => {
      const res = await request(server.port, 'POST', '/tracking/rules', {
        headers: authHeaders(),
        body: { searchQueries: ['x'] },
      });
      expect(res.status).toBe(400);
      const body = res.json() as { code: string };
      expect(body.code).toBe('validation_error');
    });

    it('400 validation_error when body is not a JSON object (array)', async () => {
      const res = await request(server.port, 'POST', '/tracking/rules', {
        headers: authHeaders(),
        body: [1, 2, 3],
      });
      expect(res.status).toBe(400);
      const body = res.json() as { code: string };
      expect(body.code).toBe('validation_error');
    });
  });

  describe('GET /tracking/rules (list reflects created rules)', () => {
    it('lists created interests with linkedEntityCount + list item key-set == INTEREST_LIST_ITEM_KEYS', async () => {
      // Ensure at least one interest exists (prior test created it).
      const res = await request(server.port, 'GET', '/tracking/rules', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = res.json() as { data: Record<string, unknown>[]; total: number };
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.total).toBe(body.data.length);
      const first = body.data[0];
      expect(first).toHaveProperty('linkedEntityCount');
      expect(first.linkedEntityCount).toBe(
        Array.isArray(first.linkedEntityIds) ? first.linkedEntityIds.length : 0,
      );
      // Stats default to zero/zero-filled sparkline for interests with no
      // executions yet — front-end relies on the fixed 14-element length
      // for sparkline rendering, so this is part of the SDK contract.
      expect(first.totalHits).toBe(0);
      expect(first.newHits24h).toBe(0);
      expect(first.ingestedTotal).toBe(0);
      expect(Array.isArray(first.sparkline)).toBe(true);
      expect((first.sparkline as number[]).length).toBe(14);
      expect((first.sparkline as number[]).every((v) => v === 0)).toBe(true);
      expect(Object.keys(first).sort()).toEqual(INTEREST_LIST_ITEM_KEYS);
    });
  });

  describe('GET /tracking/rules/:id — InterestDetail', () => {
    it('returns { data: { interest, linkedEntities, recentExecutions } } + key-sets', async () => {
      // Create a fresh interest to detail-fetch it.
      const createRes = await request(server.port, 'POST', '/tracking/rules', {
        headers: authHeaders(),
        body: { name: 'DetailTarget', searchQueries: ['x'] },
      });
      expect(createRes.status).toBe(201);
      const created = (createRes.json() as { data: { id: number } }).data;

      const detailRes = await request(server.port, 'GET', `/tracking/rules/${created.id}`, {
        headers: authHeaders(),
      });
      expect(detailRes.status).toBe(200);
      const body = detailRes.json() as {
        data: {
          interest: Record<string, unknown>;
          linkedEntities: unknown[];
          recentExecutions: unknown[];
        };
      };
      expect(body.data).toHaveProperty('interest');
      expect(body.data).toHaveProperty('linkedEntities');
      expect(body.data).toHaveProperty('recentExecutions');
      expect(body.data.interest.name).toBe('DetailTarget');
      expect(body.data.linkedEntities).toEqual([]);
      expect(Array.isArray(body.data.recentExecutions)).toBe(true);
      // Detail envelope key-set
      expect(Object.keys(body.data).sort()).toEqual(INTEREST_DETAIL_KEYS);
      // Inner Interest key-set
      expect(Object.keys(body.data.interest).sort()).toEqual(INTEREST_KEYS);
    });

    it('returns 404 for non-existent interest id', async () => {
      const res = await request(server.port, 'GET', '/tracking/rules/99999', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
      const body = res.json() as { code: string };
      expect(body.code).toBe('not_found');
    });

    it('returns 400 invalid_id for non-numeric id', async () => {
      const res = await request(server.port, 'GET', '/tracking/rules/abc', {
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);
      const body = res.json() as { code: string };
      expect(body.code).toBe('invalid_id');
    });
  });

  describe('PUT /tracking/rules/:id', () => {
    it('updates name + searchQueries', async () => {
      const createRes = await request(server.port, 'POST', '/tracking/rules', {
        headers: authHeaders(),
        body: { name: 'UpdateOrig', searchQueries: ['a'] },
      });
      expect(createRes.status).toBe(201);
      const created = (createRes.json() as { data: { id: number } }).data;

      const putRes = await request(server.port, 'PUT', `/tracking/rules/${created.id}`, {
        headers: authHeaders(),
        body: { name: 'UpdateNew', searchQueries: ['b'] },
      });
      expect(putRes.status).toBe(200);
      const body = putRes.json() as { data: Record<string, unknown> };
      expect(body.data.name).toBe('UpdateNew');
      expect(body.data.searchQueries).toEqual(['b']);
    });

    it('400 validation_error when name is not a string', async () => {
      const createRes = await request(server.port, 'POST', '/tracking/rules', {
        headers: authHeaders(),
        body: { name: 'UpdateBadName', searchQueries: ['a'] },
      });
      const created = (createRes.json() as { data: { id: number } }).data;

      const res = await request(server.port, 'PUT', `/tracking/rules/${created.id}`, {
        headers: authHeaders(),
        body: { name: 123 },
      });
      expect(res.status).toBe(400);
      const body = res.json() as { code: string };
      expect(body.code).toBe('validation_error');
    });

    it('400 validation_error when searchQueries is not an array', async () => {
      const createRes = await request(server.port, 'POST', '/tracking/rules', {
        headers: authHeaders(),
        body: { name: 'UpdateBadQueries', searchQueries: ['a'] },
      });
      const created = (createRes.json() as { data: { id: number } }).data;

      const res = await request(server.port, 'PUT', `/tracking/rules/${created.id}`, {
        headers: authHeaders(),
        body: { searchQueries: 'not-an-array' },
      });
      expect(res.status).toBe(400);
      const body = res.json() as { code: string };
      expect(body.code).toBe('validation_error');
    });
  });

  describe('DELETE /tracking/rules/:id', () => {
    it('returns 204 on success + subsequent GET returns 404', async () => {
      const createRes = await request(server.port, 'POST', '/tracking/rules', {
        headers: authHeaders(),
        body: { name: 'DeleteTarget', searchQueries: ['x'] },
      });
      const created = (createRes.json() as { data: { id: number } }).data;

      const delRes = await request(server.port, 'DELETE', `/tracking/rules/${created.id}`, {
        headers: authHeaders(),
      });
      expect(delRes.status).toBe(204);

      const getRes = await request(server.port, 'GET', `/tracking/rules/${created.id}`, {
        headers: authHeaders(),
      });
      expect(getRes.status).toBe(404);
    });
  });

  describe('POST /tracking/rules/:id/enable|disable', () => {
    it('disables then enables + flips the enabled flag', async () => {
      const createRes = await request(server.port, 'POST', '/tracking/rules', {
        headers: authHeaders(),
        body: { name: 'EnableTarget', searchQueries: ['x'] },
      });
      const created = (createRes.json() as { data: { id: number; enabled: boolean } }).data;
      expect(created.enabled).toBe(true);

      const disableRes = await request(
        server.port,
        'POST',
        `/tracking/rules/${created.id}/disable`,
        { headers: authHeaders() },
      );
      expect(disableRes.status).toBe(200);
      const disableBody = disableRes.json() as { data: { enabled: boolean } };
      expect(disableBody.data.enabled).toBe(false);

      const enableRes = await request(server.port, 'POST', `/tracking/rules/${created.id}/enable`, {
        headers: authHeaders(),
      });
      expect(enableRes.status).toBe(200);
      const enableBody = enableRes.json() as { data: { enabled: boolean } };
      expect(enableBody.data.enabled).toBe(true);
    });
  });

  describe('GET /tracking/rules/:id/executions', () => {
    it('returns paginated executions list (empty array for new rule)', async () => {
      const createRes = await request(server.port, 'POST', '/tracking/rules', {
        headers: authHeaders(),
        body: { name: 'ExecListTarget', searchQueries: ['x'] },
      });
      const created = (createRes.json() as { data: { id: number } }).data;

      const res = await request(
        server.port,
        'GET',
        `/tracking/rules/${created.id}/executions?page=1&perPage=5`,
        { headers: authHeaders() },
      );
      expect(res.status).toBe(200);
      const body = res.json() as {
        data: unknown[];
        total: number;
        page: number;
        perPage: number;
      };
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.total).toBe(0);
      expect(body.page).toBe(1);
      expect(body.perPage).toBe(5);
    });

    // Pagination parse regressions (C9). Fractional / Infinity / negative
    // used to reach better-sqlite3 as non-integer LIMIT/OFFSET bindings and
    // raise an opaque 500 `internal`. The route now parses at the boundary
    // and returns 400 validation_error. One POST + multiple GETs keeps the
    // shared-server rate-limit budget intact (creating a new rule per
    // variant trips the auth/create rate-limit).
    it('rejects malformed page/perPage (fractional / Infinity / negative) with 400', async () => {
      const createRes = await request(server.port, 'POST', '/tracking/rules', {
        headers: authHeaders(),
        body: { name: 'PaginationGuard', searchQueries: ['x'] },
      });
      const created = (createRes.json() as { data: { id: number } }).data;

      for (const query of ['perPage=1.5', 'page=Infinity', 'page=-1']) {
        const res = await request(
          server.port,
          'GET',
          `/tracking/rules/${created.id}/executions?${query}`,
          { headers: authHeaders() },
        );
        expect(res.status, `query=${query}`).toBe(400);
        expect((res.json() as { code: string }).code, `query=${query}`).toBe('validation_error');
      }
    });
  });
});

// Trigger tests run against a scheduler-disabled server so /run → 409 is observable.
describe('POST /tracking/rules/:id/run — scheduler_disabled', () => {
  let server: StartedServer;

  beforeAll(async () => {
    server = await startTestServer({
      envOverrides: { GOLDPAN_TRACKING_SCHEDULER_ENABLED: 'false' },
    });
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  const authHeaders = () => ({ Authorization: `Bearer ${server.password}` });

  it('returns 409 scheduler_disabled when GOLDPAN_TRACKING_SCHEDULER_ENABLED=false', async () => {
    const createRes = await request(server.port, 'POST', '/tracking/rules', {
      headers: authHeaders(),
      body: { name: 'RunWhileDisabled', searchQueries: ['x'] },
    });
    const created = (createRes.json() as { data: { id: number } }).data;

    const runRes = await request(server.port, 'POST', `/tracking/rules/${created.id}/run`, {
      headers: authHeaders(),
    });
    expect(runRes.status).toBe(409);
    const body = runRes.json() as { code: string };
    expect(body.code).toBe('scheduler_disabled');
  });
});

describe('GET /tracking/executions/:id — sourceId strip', () => {
  let server: StartedServer;

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  const authHeaders = () => ({ Authorization: `Bearer ${server.password}` });

  it('returns 404 for non-existent execution id', async () => {
    const res = await request(server.port, 'GET', '/tracking/executions/99999', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
    const body = res.json() as { code: string };
    expect(body.code).toBe('not_found');
  });

  it('returns 400 invalid_id for non-numeric execution id', async () => {
    const res = await request(server.port, 'GET', '/tracking/executions/abc', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('invalid_id');
  });
});

// The detail-empty-array tests above prove the detail envelope has the right
// keys, but not that populated `linkedEntities` / `recentExecutions` items
// have the right nested shape. We seed rows directly via a second SQLite
// connection against the subprocess's WAL-mode DB so the GET returns
// non-empty arrays and each element's key-set can be asserted against the
// canonical fixture key-sets. This closes the only remaining "三方 duck typing"
// drift window on the server side.
describe('GET /tracking/rules/:id — populated linkedEntities + recentExecutions shape', () => {
  let server: StartedServer;
  let seedDb: Database.Database;
  let interestId = 0;
  let executionId = 0;

  beforeAll(async () => {
    server = await startTestServer();
    // Second reader/writer against the same WAL-mode SQLite file. The
    // subprocess holds its own connection; WAL allows a second process-local
    // connection to write without blocking the server's reads/writes.
    seedDb = new Database(path.join(server.tmpDir, 'test.db'));

    // Create the interest via the public route so server.dispatcher and the
    // ordinary `validateSearchQueries` path run — we only go raw-SQL for the
    // entity / link / execution / item tables that have no public POST.
    const authHeaders = { Authorization: `Bearer ${server.password}` };
    const createRes = await request(server.port, 'POST', '/tracking/rules', {
      headers: authHeaders,
      body: { name: 'ContractLockTarget', searchQueries: ['x'] },
    });
    expect(createRes.status).toBe(201);
    interestId = (createRes.json() as { data: { id: number } }).data.id;

    // Seed: entity + link. `entities` has no public POST route — the pipeline
    // owns all entity creation — so direct SQL is the only option.
    const entityInsert = seedDb
      .prepare(
        `INSERT INTO entities (name, description, aliases, keywords)
         VALUES (?, ?, '[]', '[]')`,
      )
      .run('Linked Entity', 'seeded for contract lock');
    const entityId = Number(entityInsert.lastInsertRowid);
    seedDb
      .prepare(`INSERT INTO interest_entity_links (interest_id, entity_id) VALUES (?, ?)`)
      .run(interestId, entityId);

    // Seed: execution + item. Scheduler normally owns these; seeding directly
    // lets us test a populated recentExecutions / execution detail deterministically.
    // started_at / finished_at 是 INTEGER epoch ms 列；不要写 TEXT datetime() 表达式。
    const execInsert = seedDb
      .prepare(
        `INSERT INTO tracking_executions
           (rule_id, started_at, finished_at, status, items_found, items_submitted, error_message)
         VALUES (?,
                 CAST(ROUND((julianday('now', '-1 hour') - 2440587.5) * 86400000) AS INTEGER),
                 ${NOW_MS_SQL},
                 'done', 1, 1, NULL)`,
      )
      .run(interestId);
    executionId = Number(execInsert.lastInsertRowid);
    seedDb
      .prepare(
        `INSERT INTO tracking_items
           (rule_id, execution_id, url, title, snippet, published_at, status, source_id)
         VALUES (?, ?, 'https://example.com/seeded', 'seeded title', 'snippet', NULL, 'submitted', NULL)`,
      )
      .run(interestId, executionId);
  }, 60_000);

  afterAll(async () => {
    seedDb?.close();
    await server?.stop();
  });

  it('GET /tracking/rules/:id returns linkedEntities[0] with INTEREST_LINKED_ENTITY_KEYS', async () => {
    const res = await request(server.port, 'GET', `/tracking/rules/${interestId}`, {
      headers: { Authorization: `Bearer ${server.password}` },
    });
    expect(res.status).toBe(200);
    const body = res.json() as {
      data: {
        interest: Record<string, unknown>;
        linkedEntities: Record<string, unknown>[];
        recentExecutions: Record<string, unknown>[];
      };
    };
    expect(body.data.linkedEntities.length).toBe(1);
    expect(Object.keys(body.data.linkedEntities[0]).sort()).toEqual(INTEREST_LINKED_ENTITY_KEYS);
  });

  it('GET /tracking/rules/:id returns recentExecutions[0] with INTEREST_EXECUTION_KEYS', async () => {
    const res = await request(server.port, 'GET', `/tracking/rules/${interestId}`, {
      headers: { Authorization: `Bearer ${server.password}` },
    });
    expect(res.status).toBe(200);
    const body = res.json() as {
      data: { recentExecutions: Record<string, unknown>[] };
    };
    expect(body.data.recentExecutions.length).toBeGreaterThan(0);
    expect(Object.keys(body.data.recentExecutions[0]).sort()).toEqual(INTEREST_EXECUTION_KEYS);
  });

  it('GET /tracking/executions/:id returns INTEREST_EXECUTION_DETAIL_KEYS + items[0] without sourceId', async () => {
    const res = await request(server.port, 'GET', `/tracking/executions/${executionId}`, {
      headers: { Authorization: `Bearer ${server.password}` },
    });
    expect(res.status).toBe(200);
    const body = res.json() as {
      data: { items: Record<string, unknown>[] } & Record<string, unknown>;
    };
    // Detail envelope key-set.
    expect(Object.keys(body.data).sort()).toEqual(INTEREST_EXECUTION_DETAIL_KEYS);
    expect(body.data.items.length).toBe(1);
    // Server-side route strips `sourceId` from each item before responding;
    // SDK `InterestItem` intentionally omits it. Assert the exact post-strip key-set.
    expect(Object.keys(body.data.items[0]).sort()).toEqual(INTEREST_ITEM_KEYS);
    expect(body.data.items[0]).not.toHaveProperty('sourceId');
  });
});

// GET /tracking/search-tool-status — probe used by the web tracking page
// to render the "尚未配置 Search Tool" warning. Lives under /tracking/* so
// the same auth gate applies, but does NOT require the tracking plugin
// service to be loaded — the early-return runs before the service lookup.
describe('GET /tracking/search-tool-status', () => {
  let server: StartedServer;

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('requires auth (returns 401 without credentials)', async () => {
    const res = await request(server.port, 'GET', '/tracking/search-tool-status');
    expect(res.status).toBe(401);
  });

  it('returns { configured, providers } shape', async () => {
    const res = await request(server.port, 'GET', '/tracking/search-tool-status', {
      headers: { Authorization: `Bearer ${server.password}` },
    });
    expect(res.status).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // Lock the response key-set so SDK / web probe drift is caught here.
    expect(Object.keys(body).sort()).toEqual(['configured', 'providers']);
    expect(typeof body.configured).toBe('boolean');
    expect(Array.isArray(body.providers)).toBe(true);
    // Whether `configured` is true or false depends on which API keys the
    // test environment exposes (TAVILY_API_KEY etc.). The contract is just
    // "configured is boolean iff providers is non-empty" — locking the
    // boolean to a specific value would make this test environment-coupled
    // and flake whenever a developer runs it with a real key in their env.
    const providers = body.providers as string[];
    expect(body.configured).toBe(providers.length > 0);
  });
});

// Runtime-readiness gating: `configured` reflects whether a plugin can
// actually execute (enable toggle on AND every secret filled), not just
// whether the plugin code is loaded. Two servers spun up with deliberately
// crafted envs lock the two key transitions.
describe('GET /tracking/search-tool-status — runtime readiness', () => {
  it('reports configured=true when a search plugin has enable=true and key set', async () => {
    const server = await startTestServer({
      envOverrides: {
        TAVILY_API_KEY: 'tvly-test',
        GOLDPAN_TAVILY_SEARCH_ENABLED: 'true',
      },
    });
    try {
      const res = await request(server.port, 'GET', '/tracking/search-tool-status', {
        headers: { Authorization: `Bearer ${server.password}` },
      });
      expect(res.status).toBe(200);
      const body = res.json() as { configured: boolean; providers: string[] };
      expect(body.configured).toBe(true);
      expect(body.providers).toContain('tool-search-tavily');
    } finally {
      await server.stop();
    }
  }, 60_000);

  it('reports configured=false when key is set but enable toggle is off', async () => {
    const server = await startTestServer({
      envOverrides: {
        TAVILY_API_KEY: 'tvly-test',
        GOLDPAN_TAVILY_SEARCH_ENABLED: 'false',
        // Belt-and-suspenders: the other search plugins default to off, but a
        // developer running this with a populated .env may have Brave / Serper /
        // Google enabled, which would flip `configured` to true via a sibling
        // and mask the Tavily-toggle regression we're locking down here.
        GOLDPAN_GOOGLE_SEARCH_ENABLED: 'false',
        GOLDPAN_BRAVE_SEARCH_ENABLED: 'false',
        GOLDPAN_SERPER_SEARCH_ENABLED: 'false',
        GOLDPAN_EXA_SEARCH_ENABLED: 'false',
        GOLDPAN_SEARXNG_SEARCH_ENABLED: 'false',
      },
    });
    try {
      const res = await request(server.port, 'GET', '/tracking/search-tool-status', {
        headers: { Authorization: `Bearer ${server.password}` },
      });
      expect(res.status).toBe(200);
      const body = res.json() as { configured: boolean; providers: string[] };
      expect(body.configured).toBe(false);
      expect(body.providers).toEqual([]);
    } finally {
      await server.stop();
    }
  }, 60_000);
});

// Mutation endpoints must reject unauthenticated traffic. Only GET was covered
// earlier; without these, a regression in main.ts dispatch (e.g. someone
// accidentally dropping `if (!authRequired()) return` before /tracking) would
// silently expose create/update/delete to the public.
describe('/tracking mutation endpoints — auth required', () => {
  let server: StartedServer;

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('POST /tracking/rules returns 401 without credentials', async () => {
    const res = await request(server.port, 'POST', '/tracking/rules', {
      body: { name: 'x', searchQueries: ['y'] },
    });
    expect(res.status).toBe(401);
  });

  it('PUT /tracking/rules/:id returns 401 without credentials', async () => {
    const res = await request(server.port, 'PUT', '/tracking/rules/1', {
      body: { name: 'x' },
    });
    expect(res.status).toBe(401);
  });

  it('DELETE /tracking/rules/:id returns 401 without credentials', async () => {
    const res = await request(server.port, 'DELETE', '/tracking/rules/1');
    expect(res.status).toBe(401);
  });

  it('POST /tracking/rules/:id/enable returns 401 without credentials', async () => {
    const res = await request(server.port, 'POST', '/tracking/rules/1/enable');
    expect(res.status).toBe(401);
  });

  it('POST /tracking/rules/:id/disable returns 401 without credentials', async () => {
    const res = await request(server.port, 'POST', '/tracking/rules/1/disable');
    expect(res.status).toBe(401);
  });
});

// Malformed JSON must be rejected by the central `parseJsonBody` helper with
// `invalid_json` 400, not surface as an opaque 500. Mirrors the identical test
// in routes.test.ts for /github/refresh.
describe('/tracking — malformed JSON body', () => {
  let server: StartedServer;

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  async function rawPost(path: string, body: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = require('node:http').request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          method: 'POST',
          path,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${server.password}`,
          },
        },
        (r: { statusCode: number; on: (e: string, cb: (chunk: Buffer) => void) => void }) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () =>
            resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf-8') }),
          );
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async function rawPut(path: string, body: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = require('node:http').request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          method: 'PUT',
          path,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${server.password}`,
          },
        },
        (r: { statusCode: number; on: (e: string, cb: (chunk: Buffer) => void) => void }) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () =>
            resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf-8') }),
          );
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  it('POST /tracking/rules with non-JSON body returns 400 invalid_json', async () => {
    const raw = await rawPost('/tracking/rules', 'not-json');
    expect(raw.status).toBe(400);
    expect(JSON.parse(raw.body).code).toBe('invalid_json');
  });

  it('POST /tracking/rules with truncated JSON returns 400 invalid_json', async () => {
    const raw = await rawPost('/tracking/rules', '{"name": "x", ');
    expect(raw.status).toBe(400);
    expect(JSON.parse(raw.body).code).toBe('invalid_json');
  });

  it('PUT /tracking/rules/:id with non-JSON body returns 400 invalid_json', async () => {
    const raw = await rawPut('/tracking/rules/1', 'still-not-json');
    expect(raw.status).toBe(400);
    expect(JSON.parse(raw.body).code).toBe('invalid_json');
  });

  // Regression: body 'null' is valid JSON but has no meaning for POST/PUT
  // endpoints. The central parseJsonBody treats it as invalid_json so callers
  // can keep the "null = response written, return" sentinel without needing
  // per-route duplication. Previously the handler silently returned and the
  // request hung until the client timed out.
  it('POST /tracking/rules with body "null" returns 400 invalid_json', async () => {
    const raw = await rawPost('/tracking/rules', 'null');
    expect(raw.status).toBe(400);
    expect(JSON.parse(raw.body).code).toBe('invalid_json');
  });

  it('PUT /tracking/rules/:id with body "null" returns 400 invalid_json', async () => {
    const raw = await rawPut('/tracking/rules/1', 'null');
    expect(raw.status).toBe(400);
    expect(JSON.parse(raw.body).code).toBe('invalid_json');
  });
});
