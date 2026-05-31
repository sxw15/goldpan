import path from 'node:path';
import { mintShareUrl } from '@goldpan/core/digest-link/sign';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request, type StartedServer, startTestServer } from '../helpers';

describe('GET /digest/preview (plugin disabled)', () => {
  let server: StartedServer;

  beforeAll(async () => {
    server = await startTestServer({
      envOverrides: { GOLDPAN_DIGEST_ENABLED: 'false' },
    });
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('returns 503 + plugin_disabled when GOLDPAN_DIGEST_ENABLED=false', async () => {
    const res = await request(server.port, 'GET', '/digest/preview', {
      headers: { Authorization: `Bearer ${server.password}` },
    });
    expect(res.status).toBe(503);
    const body = res.json() as { type: string; code: string };
    expect(body.type).toBe('error');
    expect(body.code).toBe('plugin_disabled');
  });
});

describe('GET /digest/preview (plugin enabled)', () => {
  let server: StartedServer;

  beforeAll(async () => {
    server = await startTestServer({
      envOverrides: {
        GOLDPAN_DIGEST_ENABLED: 'true',
        // Digest backfill calls callLlm with dummy keys — cap latency so
        // forceRegenerate / Vitest deadlines are not stuck on the default 30s.
        GOLDPAN_LLM_TIMEOUT: '5',
      },
      startupTimeoutMs: 60_000,
    });

    // Match GET /digest/share suite: /health returns before async postInit
    // backfill commits; poll then fall back to one API regenerate.
    const auth = { headers: { Authorization: `Bearer ${server.password}` } };
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && getBackfillRowId(server.tmpDir) === null) {
      await new Promise((r) => setTimeout(r, 300));
    }
    if (getBackfillRowId(server.tmpDir) === null) {
      await request(server.port, 'GET', '/digest/preview?channel=web&forceRegenerate=true', auth);
    }
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('returns 200 + { snapshot, generatedAt, status } without markdown when no report exists', async () => {
    const res = await request(server.port, 'GET', '/digest/preview?channel=web&date=2026-04-18', {
      headers: { Authorization: `Bearer ${server.password}` },
    });
    expect(res.status).toBe(200);
    const body = res.json() as {
      snapshot: unknown;
      generatedAt: string | null;
      status: string;
    };
    expect(body.snapshot).toBeNull();
    expect(body.generatedAt).toBeNull();
    expect(body.status).toBe('missing');
    expect(body).not.toHaveProperty('markdown');
  });

  it('defaults `date` to *yesterday* UTC when not supplied (matches scheduler persistence target)', async () => {
    // Without `?date=`, the server must look up yesterday (UTC) — the date the
    // data-snapshot / backfill / push schedulers write to `daily_reports`.
    // Falling back to *today* (prior behavior) always hit the missing-report
    // branch on first page load. Regression lock for P1-2.
    //
    // The test server runs the real startup backfill (postInit) which writes a
    // row for yesterday-UTC, so querying without `?date=` must return that
    // row's shape — not a `snapshot: null`. Pin: the default-date request
    // resolves to yesterday's snapshot, equivalent to the explicit
    // `?date=<yesterday-UTC>` request.
    const yesterdayIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const defaultRes = await request(server.port, 'GET', '/digest/preview?channel=web', {
      headers: { Authorization: `Bearer ${server.password}` },
    });
    expect(defaultRes.status).toBe(200);
    const explicitRes = await request(
      server.port,
      'GET',
      `/digest/preview?channel=web&date=${yesterdayIso}`,
      { headers: { Authorization: `Bearer ${server.password}` } },
    );
    expect(explicitRes.status).toBe(200);
    const defaultBody = defaultRes.json() as { snapshot: unknown };
    const explicitBody = explicitRes.json() as { snapshot: unknown };
    // Both responses target the same underlying row, so the `snapshot` field
    // must agree (either both null for a clean DB, or both the same snapshot
    // when backfill seeded yesterday).
    expect(defaultBody.snapshot).toEqual(explicitBody.snapshot);
  });

  it('returns 200 + preset list', async () => {
    const res = await request(server.port, 'GET', '/digest/presets?channel=web', {
      headers: { Authorization: `Bearer ${server.password}` },
    });
    expect(res.status).toBe(200);
    const body = res.json() as { presets: unknown[] };
    expect(Array.isArray(body.presets)).toBe(true);
  });

  it('falls back to the channel-level snapshot for daily presets that have no preset-specific row yet', async () => {
    const auth = { headers: { Authorization: `Bearer ${server.password}` } };
    const createRes = await request(server.port, 'POST', '/digest/presets?channel=web', {
      ...auth,
      body: {
        name: 'daily-fallback-check',
        period: 'daily',
        pushDay: null,
        pushTime: '08:00',
        windowMode: 'calendar',
        slots: ['stats'],
        skipEmpty: true,
        includeAiSummary: false,
        isDefault: false,
      },
    });
    expect(createRes.status).toBe(201);
    const presetId = (createRes.json() as { preset: { id: number } }).preset.id;
    const yesterdayIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);

    const previewRes = await request(
      server.port,
      'GET',
      `/digest/preview?channel=web&date=${yesterdayIso}&presetId=${presetId}`,
      auth,
    );
    expect(previewRes.status).toBe(200);
    expect((previewRes.json() as { snapshot: unknown }).snapshot).not.toBeNull();
  });

  it('returns status that matches the SDK DigestSnapshotStatus union (not raw aiSummaryStatus)', async () => {
    // The wire `status` field is `'cached' | 'generated' | 'missing' | 'pending'`
    // (DigestSnapshotStatus). Server must NOT leak the plugin-internal
    // `'complete'` / `'fallback'` aiSummaryStatus values directly.
    const auth = { headers: { Authorization: `Bearer ${server.password}` } };
    const yesterdayIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const cached = await request(
      server.port,
      'GET',
      `/digest/preview?channel=web&date=${yesterdayIso}`,
      auth,
    );
    expect(cached.status).toBe(200);
    const cachedBody = cached.json() as { snapshot: unknown; status: string };
    if (cachedBody.snapshot !== null) {
      expect(['cached', 'generated', 'pending']).toContain(cachedBody.status);
      expect(cachedBody.status).not.toBe('complete');
      expect(cachedBody.status).not.toBe('fallback');
    }

    const regen = await request(
      server.port,
      'GET',
      `/digest/preview?channel=web&date=${yesterdayIso}&forceRegenerate=true`,
      auth,
    );
    expect(regen.status).toBe(200);
    const regenBody = regen.json() as { snapshot: unknown; status: string };
    // forceRegenerate path must tag 'generated' (or 'pending' if AI not done)
    // so polling clients can distinguish a fresh snapshot from a cache hit.
    expect(['generated', 'pending']).toContain(regenBody.status);
  });

  it('does not fall back to the channel-level daily snapshot for weekly presets', async () => {
    const auth = { headers: { Authorization: `Bearer ${server.password}` } };
    const createRes = await request(server.port, 'POST', '/digest/presets?channel=web', {
      ...auth,
      body: {
        name: 'weekly-no-daily-fallback',
        period: 'weekly',
        pushDay: 1,
        pushTime: '08:00',
        windowMode: 'calendar',
        slots: ['stats'],
        skipEmpty: true,
        includeAiSummary: false,
        isDefault: false,
      },
    });
    expect(createRes.status).toBe(201);
    const presetId = (createRes.json() as { preset: { id: number } }).preset.id;
    const yesterdayIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);

    const previewRes = await request(
      server.port,
      'GET',
      `/digest/preview?channel=web&date=${yesterdayIso}&presetId=${presetId}`,
      auth,
    );
    expect(previewRes.status).toBe(200);
    const body = previewRes.json() as { snapshot: unknown };
    expect(body.snapshot).toBeNull();
    expect(body).not.toHaveProperty('markdown');
  });

  it('does not fall back to the channel-level calendar snapshot for rolling daily presets', async () => {
    const auth = { headers: { Authorization: `Bearer ${server.password}` } };
    const createRes = await request(server.port, 'POST', '/digest/presets?channel=web', {
      ...auth,
      body: {
        name: 'rolling-daily-no-calendar-fallback',
        period: 'daily',
        pushDay: null,
        pushTime: '08:00',
        windowMode: 'rolling',
        slots: ['stats'],
        skipEmpty: true,
        includeAiSummary: false,
        isDefault: false,
      },
    });
    expect(createRes.status).toBe(201);
    const presetId = (createRes.json() as { preset: { id: number } }).preset.id;
    const yesterdayIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);

    const previewRes = await request(
      server.port,
      'GET',
      `/digest/preview?channel=web&date=${yesterdayIso}&presetId=${presetId}`,
      auth,
    );
    expect(previewRes.status).toBe(200);
    const body = previewRes.json() as { snapshot: unknown };
    expect(body.snapshot).toBeNull();
  });
});

describe('GET /digest/connections', () => {
  let server: StartedServer;

  beforeAll(async () => {
    server = await startTestServer({
      envOverrides: { GOLDPAN_DIGEST_ENABLED: 'true' },
    });
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('returns 200 with {data, total} when given a valid since', async () => {
    const since = Date.now() - 7 * 86400 * 1000;
    const res = await request(
      server.port,
      'GET',
      `/digest/connections?since=${Math.floor(since)}`,
      { headers: { Authorization: `Bearer ${server.password}` } },
    );
    expect(res.status).toBe(200);
    const body = res.json() as { data: unknown[]; total: number };
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('returns 400 invalid_since on non-integer since', async () => {
    const res = await request(server.port, 'GET', '/digest/connections?since=notanumber', {
      headers: { Authorization: `Bearer ${server.password}` },
    });
    expect(res.status).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('invalid_since');
  });

  it('returns 400 invalid_limit on out-of-range limit', async () => {
    const res = await request(server.port, 'GET', '/digest/connections?since=0&limit=99', {
      headers: { Authorization: `Bearer ${server.password}` },
    });
    expect(res.status).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('invalid_limit');
  });

  it('returns 400 invalid_since when `since` is the empty string', async () => {
    const res = await request(server.port, 'GET', '/digest/connections?since=', {
      headers: { Authorization: `Bearer ${server.password}` },
    });
    expect(res.status).toBe(400);
    expect((res.json() as { code: string }).code).toBe('invalid_since');
  });

  it('returns 400 invalid_since when `since` exceeds MAX_SAFE_DATE_MS (8.64e15)', async () => {
    const res = await request(server.port, 'GET', '/digest/connections?since=9000000000000001', {
      headers: { Authorization: `Bearer ${server.password}` },
    });
    expect(res.status).toBe(400);
    expect((res.json() as { code: string }).code).toBe('invalid_since');
  });

  it('returns 400 invalid_since when `since` is not a safe integer (1e30)', async () => {
    const res = await request(server.port, 'GET', '/digest/connections?since=1e30', {
      headers: { Authorization: `Bearer ${server.password}` },
    });
    expect(res.status).toBe(400);
    expect((res.json() as { code: string }).code).toBe('invalid_since');
  });
});

// ---------------------------------------------------------------------------
// GET /digest/share/:id
// ---------------------------------------------------------------------------

const SIGNING_KEY = 'a'.repeat(32);
const BASE_URL = 'http://localhost';

/**
 * Read the row id for the backfill row (channel=web, yesterday, preset_id IS NULL)
 * directly from the SQLite file. The server holds the WAL connection; reading
 * from a second connection is safe (SQLite WAL allows concurrent readers).
 */
function getBackfillRowId(tmpDir: string): number | null {
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath, { readonly: true });
  try {
    const yesterdayIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const row = db
      .prepare(
        `SELECT id FROM daily_reports WHERE channel = 'web' AND report_date = ? AND preset_id IS NULL LIMIT 1`,
      )
      .get(yesterdayIso) as { id: number } | undefined;
    return row ? row.id : null;
  } finally {
    db.close();
  }
}

/**
 * Extract the `sig` query parameter from a minted share URL.
 */
function extractSig(url: string): string {
  return new URL(url).searchParams.get('sig') ?? '';
}

describe('GET /digest/share/:id', () => {
  let server: StartedServer;
  let rowId: number;

  beforeAll(async () => {
    server = await startTestServer({
      envOverrides: {
        GOLDPAN_DIGEST_ENABLED: 'true',
        GOLDPAN_DIGEST_LINK_SIGNING_KEY: SIGNING_KEY,
        GOLDPAN_DIGEST_PUBLIC_BASE_URL: BASE_URL,
      },
      // Give backfill more time to complete
      startupTimeoutMs: 60_000,
    });

    // Wait for the backfill to write the yesterday row. The existing preview
    // test confirms the server writes it at startup; we poll a bit to avoid
    // a race between /health returning 200 and the async backfill committing.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const id = getBackfillRowId(server.tmpDir);
      if (id !== null) {
        rowId = id;
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!rowId) {
      // Fallback: force-regenerate via the API to ensure a row exists
      await request(server.port, 'GET', '/digest/preview?channel=web&forceRegenerate=true', {
        headers: { Authorization: `Bearer ${server.password}` },
      });
      const id = getBackfillRowId(server.tmpDir);
      rowId = id ?? 1;
    }
  }, 90_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('returns 200 + snapshot for a valid sig', async () => {
    const url = mintShareUrl({
      digestId: rowId,
      signingKey: SIGNING_KEY,
      ttlDays: 7,
      publicBaseUrl: BASE_URL,
    });
    const sig = extractSig(url);
    const res = await request(server.port, 'GET', `/digest/share/${rowId}?sig=${sig}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store, private');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    const body = res.json() as {
      snapshot: unknown;
      generatedAt: number;
      status: string;
      channel: string;
      date: string;
      presetId: number | null;
      preset: unknown;
    };
    expect(body.snapshot).not.toBeNull();
    expect(typeof body.generatedAt).toBe('number');
    expect(['pending', 'cached']).toContain(body.status);
    expect(body.channel).toBe('web');
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Backfill row 是 preset_id IS NULL → preset 字段必须 null。
    expect(body.presetId).toBeNull();
    expect(body.preset).toBeNull();
  });

  it('POST /digest/share-link falls back to the channel row while preserving the requested preset render config', async () => {
    const dbPath = path.join(server.tmpDir, 'test.db');
    const db = new Database(dbPath);
    let presetRowId: number;
    try {
      const now = Date.now();
      const presetInfo = db
        .prepare(
          `INSERT INTO digest_presets (channel, name, period, push_day, slots_json, skip_empty,
              include_ai_summary, is_default, created_at, updated_at)
           VALUES ('web', 'share-link-fallback-preset', 'daily', NULL, ?, 1, 0, 0, ?, ?)`,
        )
        .run(JSON.stringify(['stats']), now, now);
      presetRowId = Number(presetInfo.lastInsertRowid);
    } finally {
      db.close();
    }

    const yesterdayIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const linkRes = await request(server.port, 'POST', '/digest/share-link', {
      headers: { Authorization: `Bearer ${server.password}` },
      body: { channel: 'web', date: yesterdayIso, presetId: presetRowId },
    });
    expect(linkRes.status).toBe(200);
    const { url } = linkRes.json() as { url: string };
    const shareUrl = new URL(url);
    expect(shareUrl.pathname).toBe(`/digest/share/${rowId}`);

    const shareRes = await request(server.port, 'GET', `${shareUrl.pathname}${shareUrl.search}`);
    expect(shareRes.status).toBe(200);
    const body = shareRes.json() as {
      presetId: number | null;
      preset: { slots: string[]; skipEmpty: boolean; includeAiSummary: boolean; period: string };
    };
    expect(body.presetId).toBeNull();
    expect(body.preset).toEqual({
      slots: ['stats'],
      skipEmpty: true,
      includeAiSummary: false,
      period: 'daily',
    });
  });

  it('attaches preset {slots, skipEmpty, includeAiSummary} when row has non-null preset_id', async () => {
    // 直接在 SQLite 里插一个 preset + 一个绑定该 preset 的 daily_reports 行,
    // 避开 forceRegenerate 触发真 LLM call。
    const dbPath = path.join(server.tmpDir, 'test.db');
    const db = new Database(dbPath);
    let presetRowId: number;
    let dailyRowId: number;
    try {
      const yesterdayIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
      const now = Date.now();
      const presetSlots = JSON.stringify(['captures', 'stats']);
      const presetInfo = db
        .prepare(
          `INSERT INTO digest_presets (channel, name, period, push_day, slots_json, skip_empty,
              include_ai_summary, is_default, created_at, updated_at)
           VALUES ('web', 'share-test-preset', 'daily', NULL, ?, 1, 0, 0, ?, ?)`,
        )
        .run(presetSlots, now, now);
      presetRowId = Number(presetInfo.lastInsertRowid);
      const snapshotJson = JSON.stringify({ test: 'snapshot' });
      const dailyInfo = db
        .prepare(
          `INSERT INTO daily_reports (channel, report_date, period, preset_id, snapshot_json,
              ai_summary_status, generated_at)
           VALUES ('web', ?, 'daily', ?, ?, 'complete', ?)`,
        )
        .run(yesterdayIso, presetRowId, snapshotJson, now);
      dailyRowId = Number(dailyInfo.lastInsertRowid);
    } finally {
      db.close();
    }

    const url = mintShareUrl({
      digestId: dailyRowId,
      signingKey: SIGNING_KEY,
      ttlDays: 7,
      publicBaseUrl: BASE_URL,
    });
    const sig = extractSig(url);
    const res = await request(server.port, 'GET', `/digest/share/${dailyRowId}?sig=${sig}`);
    expect(res.status).toBe(200);
    const body = res.json() as {
      presetId: number | null;
      preset: {
        slots: string[];
        skipEmpty: boolean;
        includeAiSummary: boolean;
        period: string;
      } | null;
    };
    expect(body.presetId).toBe(presetRowId);
    expect(body.preset).toEqual({
      slots: ['captures', 'stats'],
      skipEmpty: true,
      includeAiSummary: false,
      period: 'daily',
    });
  });

  it('degrades to preset:null when daily_reports row references a deleted preset', async () => {
    const dbPath = path.join(server.tmpDir, 'test.db');
    const db = new Database(dbPath);
    let danglingRowId: number;
    try {
      // 用 +1 天避开 backfill (yesterday) + 上一个测试的 (yesterday + 真 preset)
      // unique index 冲突。preset_id 10000 故意指向不存在的 row,模拟 preset 被删
      // 后留下的孤儿 daily_reports。
      const tomorrowIso = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
      const snapshotJson = JSON.stringify({ test: 'orphan' });
      const info = db
        .prepare(
          `INSERT INTO daily_reports (channel, report_date, period, preset_id, snapshot_json,
              ai_summary_status, generated_at)
           VALUES ('web', ?, 'daily', 10000, ?, 'complete', ?)`,
        )
        .run(tomorrowIso, snapshotJson, Date.now());
      danglingRowId = Number(info.lastInsertRowid);
    } finally {
      db.close();
    }

    const url = mintShareUrl({
      digestId: danglingRowId,
      signingKey: SIGNING_KEY,
      ttlDays: 7,
      publicBaseUrl: BASE_URL,
    });
    const sig = extractSig(url);
    const res = await request(server.port, 'GET', `/digest/share/${danglingRowId}?sig=${sig}`);
    expect(res.status).toBe(200);
    const body = res.json() as {
      presetId: number | null;
      preset: unknown;
    };
    expect(body.presetId).toBe(10000);
    expect(body.preset).toBeNull();
  });

  it('returns 410 share_link_invalid for expired sig', async () => {
    // nowMs set 8 days in the past so exp (nowMs + 7*86400) is also in the past
    const pastMs = Date.now() - 8 * 24 * 3600 * 1000;
    const url = mintShareUrl({
      digestId: rowId,
      signingKey: SIGNING_KEY,
      ttlDays: 7,
      publicBaseUrl: BASE_URL,
      nowMs: pastMs,
    });
    const sig = extractSig(url);
    const res = await request(server.port, 'GET', `/digest/share/${rowId}?sig=${sig}`);
    expect(res.status).toBe(410);
    const body = res.json() as { code: string };
    expect(body.code).toBe('share_link_invalid');
  });

  it('returns 410 for tampered sig (valid payload, wrong HMAC)', async () => {
    // Mint with correct key to get a valid payload, then swap the HMAC part
    // with a wrong signature of the correct byte-length (32 bytes → 43 base64url chars).
    const url = mintShareUrl({
      digestId: rowId,
      signingKey: SIGNING_KEY,
      ttlDays: 7,
      publicBaseUrl: BASE_URL,
    });
    const sig = extractSig(url);
    const [payloadPart] = sig.split('.');
    // Replace HMAC with 32 zero-bytes encoded as base64url (valid length, wrong value)
    const wrongSig = Buffer.alloc(32)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const tamperedSig = `${payloadPart}.${wrongSig}`;
    const res = await request(server.port, 'GET', `/digest/share/${rowId}?sig=${tamperedSig}`);
    expect(res.status).toBe(410);
    const body = res.json() as { code: string };
    expect(body.code).toBe('share_link_invalid');
  });

  it('returns 400 share_link_malformed when sig missing', async () => {
    const res = await request(server.port, 'GET', `/digest/share/${rowId}`);
    expect(res.status).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('share_link_malformed');
  });

  it('returns 410 when row does not exist (valid sig for non-existent id)', async () => {
    const nonExistentId = 999_999;
    const url = mintShareUrl({
      digestId: nonExistentId,
      signingKey: SIGNING_KEY,
      ttlDays: 7,
      publicBaseUrl: BASE_URL,
    });
    const sig = extractSig(url);
    const res = await request(server.port, 'GET', `/digest/share/${nonExistentId}?sig=${sig}`);
    expect(res.status).toBe(410);
    const body = res.json() as { code: string };
    expect(body.code).toBe('share_link_invalid');
  });

  it('returns 200 even with invalid Bearer token (auth bypass verified)', async () => {
    const url = mintShareUrl({
      digestId: rowId,
      signingKey: SIGNING_KEY,
      ttlDays: 7,
      publicBaseUrl: BASE_URL,
    });
    const sig = extractSig(url);
    // Deliberately wrong bearer — proves auth is bypassed for share routes
    const res = await request(server.port, 'GET', `/digest/share/${rowId}?sig=${sig}`, {
      headers: { Authorization: 'Bearer totally-wrong-password' },
    });
    expect(res.status).toBe(200);
  });

  it('returns 405 for non-GET methods', async () => {
    const url = mintShareUrl({
      digestId: rowId,
      signingKey: SIGNING_KEY,
      ttlDays: 7,
      publicBaseUrl: BASE_URL,
    });
    const sig = extractSig(url);
    const res = await request(server.port, 'POST', `/digest/share/${rowId}?sig=${sig}`);
    expect(res.status).toBe(405);
    const body = res.json() as { code: string };
    expect(body.code).toBe('method_not_allowed');
  });
});

describe('GET /digest/share/:id (signingKey unconfigured)', () => {
  let server: StartedServer;

  beforeAll(async () => {
    server = await startTestServer({
      envOverrides: {
        GOLDPAN_DIGEST_ENABLED: 'true',
        // Deliberately omit GOLDPAN_DIGEST_LINK_SIGNING_KEY
      },
    });
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('returns 410 when signingKey is unconfigured', async () => {
    // Any sig — rejected before HMAC verify because signingKey is null
    const res = await request(server.port, 'GET', '/digest/share/1?sig=a.b');
    expect(res.status).toBe(410);
    const body = res.json() as { code: string };
    expect(body.code).toBe('share_link_invalid');
  });
});
