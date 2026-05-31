import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigStore } from '@goldpan/core/config';
import { createConfigStore } from '@goldpan/core/config';
import { createDatabase, type DrizzleDB, getRawDatabase } from '@goldpan/core/db';
import { resolveMigrationsFolder, runMigrations } from '@goldpan/core/db/migrate';
import { SqliteRuntimeConfigOverrideRepository } from '@goldpan/core/db/repositories';
import { createRootLogger } from '@goldpan/core/logger';
import { buildContributionEnvSchema, type PluginSettingsContribution } from '@goldpan/core/plugins';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  buildEnvState,
  createSettingsRoutes,
  type SettingsRouteDeps,
} from '../../src/routes/settings.js';
import type { RouteContext } from '../../src/routes/types.js';

const SILENT_LOGGER = createRootLogger('error');

interface TestDB {
  db: DrizzleDB;
  cleanup: () => void;
}

function createTestDB(): TestDB {
  const tmpDir = mkdtempSync(join(tmpdir(), 'settings-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const db = createDatabase(dbPath);
  runMigrations(db, resolveMigrationsFolder());
  return {
    db,
    cleanup: () => {
      try {
        getRawDatabase(db).close();
      } catch {
        /* already closed */
      }
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// Minimal env that satisfies cross-field validation in `loadConfig` /
// `validateStagedConfig`. Without these the snapshot construction throws
// (production-requires-password style errors).
const MIN_VALID_ENV: NodeJS.ProcessEnv = {
  GOLDPAN_LANGUAGE: 'en',
  GOLDPAN_LLM_CLASSIFIER: 'openai:gpt-4o-mini',
  GOLDPAN_LLM_EXTRACTOR: 'openai:gpt-4o-mini',
  GOLDPAN_LLM_MATCHER: 'openai:gpt-4o-mini',
  GOLDPAN_LLM_COMPARATOR: 'openai:gpt-4o-mini',
  GOLDPAN_LLM_INTENT: 'openai:gpt-4o-mini',
  GOLDPAN_LLM_QUERY: 'openai:gpt-4o-mini',
  OPENAI_API_KEY: 'sk-test-baseline',
  ANTHROPIC_API_KEY: 'sk-ant-test',
};

async function createStoreAndRepo(bootEnv: NodeJS.ProcessEnv = MIN_VALID_ENV): Promise<{
  store: ConfigStore;
  repo: SqliteRuntimeConfigOverrideRepository;
  cleanup: () => void;
}> {
  const t = createTestDB();
  const store = await createConfigStore({
    db: t.db,
    bootEnv,
    applyToProcessEnv: true,
    logger: SILENT_LOGGER,
  });
  const repo = new SqliteRuntimeConfigOverrideRepository(t.db);
  return { store, repo, cleanup: t.cleanup };
}

// `buildEnvState` tests only need the store; threading the repo through
// would trip biome's `noUnusedVariables`. This thin wrapper hides the
// extra field so those tests stay legible.
async function createStore(
  bootEnv: NodeJS.ProcessEnv = MIN_VALID_ENV,
): Promise<{ store: ConfigStore; cleanup: () => void }> {
  const { store, cleanup } = await createStoreAndRepo(bootEnv);
  return { store, cleanup };
}

// Wraps `createSettingsRoutes` so each test doesn't have to thread the
// `runtimeConfigOverrideRepo` field through. Tests pre-PR-3 only needed
// `{ configStore, bootEnv }`; this helper preserves that shape and lets
// per-test extras (callbacks etc.) merge in via the optional fourth arg.
function createRoutesForTest(
  store: ConfigStore,
  bootEnv: NodeJS.ProcessEnv,
  repo: SqliteRuntimeConfigOverrideRepository,
  extras?: Partial<SettingsRouteDeps>,
): ReturnType<typeof createSettingsRoutes> {
  return createSettingsRoutes({
    configStore: store,
    bootEnv,
    runtimeConfigOverrideRepo: repo,
    ...extras,
  });
}

interface MockRes {
  res: http.ServerResponse;
  status: () => number;
  header: (name: string) => string | number | string[] | undefined;
  json: () => unknown;
  text: () => string;
}

function mockRes(): MockRes {
  let statusCode = 0;
  let bodyText = '';
  const headers: Record<string, string | number | string[]> = {};
  const res = {
    setHeader: (name: string, value: string | number | string[]) => {
      headers[name.toLowerCase()] = value;
    },
    writeHead: (s: number, h?: Record<string, string | number | string[]>) => {
      statusCode = s;
      if (h) {
        for (const [name, value] of Object.entries(h)) {
          headers[name.toLowerCase()] = value;
        }
      }
    },
    end: (chunk?: string) => {
      if (chunk) bodyText = chunk;
    },
    headersSent: false,
  } as unknown as http.ServerResponse;
  return {
    res,
    status: () => statusCode,
    header: (name: string) => headers[name.toLowerCase()],
    json: () => (bodyText ? JSON.parse(bodyText) : null),
    text: () => bodyText,
  };
}

function mockReq(method: string): http.IncomingMessage {
  const req = new EventEmitter() as unknown as http.IncomingMessage;
  (req as unknown as { method: string }).method = method;
  // resume() is invoked by handlers that drain the body — no-op for unit test
  (req as unknown as { resume: () => void }).resume = () => undefined;
  return req;
}

function buildCtx(opts: { method: string; pathTail: string; body?: string }): {
  ctx: RouteContext;
  resWrap: MockRes;
} {
  const resWrap = mockRes();
  const segments = opts.pathTail.split('/').filter(Boolean);
  const ctx: RouteContext = {
    req: mockReq(opts.method),
    res: resWrap.res,
    url: new URL(`http://localhost/settings/${opts.pathTail}`),
    segments,
    // Only logger is used by the settings handler.
    handle: { logger: { error: () => undefined } } as unknown as RouteContext['handle'],
    readBody: async () => opts.body ?? '',
    getClientIp: () => '127.0.0.1',
    debugApiEnabled: false,
  };
  return { ctx, resWrap };
}

describe('buildEnvState', () => {
  // process.env leaks from the dev shell would mask the assertions on
  // `configured` and `source`. Pin both env vars to known values per test —
  // the ConfigStore mutates process.env via applyMergedToProcessEnv, so
  // restoring is mandatory between tests.
  let envBackup: NodeJS.ProcessEnv;
  let cleanups: Array<() => void> = [];
  beforeEach(() => {
    envBackup = { ...process.env };
    cleanups = [];
  });
  afterEach(() => {
    process.env = envBackup;
    for (const c of cleanups) c();
  });

  test('masks secret keys with last-4-only and returns full value for non-secrets', async () => {
    const bootEnv = {
      ...MIN_VALID_ENV,
      OPENAI_API_KEY: 'sk-1234567890abcdef1234567890',
      GOLDPAN_LANGUAGE: 'zh',
    };
    const { store, cleanup } = await createStore(bootEnv);
    cleanups.push(cleanup);
    const items = buildEnvState(store, bootEnv);
    const openai = items.find((i) => i.key === 'OPENAI_API_KEY');
    const lang = items.find((i) => i.key === 'GOLDPAN_LANGUAGE');

    expect(openai?.configured).toBe(true);
    expect(openai?.source).toBe('env');
    expect(openai?.mask).toBe('••••7890');
    // Hard guarantee: any prefix beyond the last 4 chars stays masked.
    expect(openai?.mask).not.toContain('sk-');
    expect(openai?.mask).not.toContain('567890abcdef');

    expect(lang?.configured).toBe(true);
    expect(lang?.source).toBe('env');
    expect(lang?.mask).toBe('zh');
  });

  test('falls back to full bullets for short secrets to keep leak ratio low', async () => {
    // 9-char password with last-4 visible would expose 4/9 ≈ 44% of the value.
    // Below the 12-char threshold we return only `••••` so short-but-valid
    // passwords are not nearly recoverable from /settings/env-state.
    const bootEnv = { ...MIN_VALID_ENV, GOLDPAN_AUTH_PASSWORD: 'shortpw99' };
    const { store, cleanup } = await createStore(bootEnv);
    cleanups.push(cleanup);
    const item = buildEnvState(store, bootEnv).find((i) => i.key === 'GOLDPAN_AUTH_PASSWORD');
    expect(item?.mask).toBe('••••');
  });

  test('strips embedded user:pass@ from non-secret URL keys', async () => {
    // OPENAI_BASE_URL doesn't match the secret-suffix regex but can carry
    // credentials in the URL form `https://user:pass@host/v1`. Returning that
    // plaintext to the browser would leak them; strip userinfo first.
    const bootEnv = {
      ...MIN_VALID_ENV,
      OPENAI_BASE_URL: 'https://alice:s3cret@proxy.example.com/v1',
    };
    const { store, cleanup } = await createStore(bootEnv);
    cleanups.push(cleanup);
    const item = buildEnvState(store, bootEnv).find((i) => i.key === 'OPENAI_BASE_URL');
    expect(item?.mask).not.toContain('alice');
    expect(item?.mask).not.toContain('s3cret');
    expect(item?.mask).toContain('proxy.example.com');
  });

  test('reports source=env when bootEnv defines the key', async () => {
    const bootEnv = { ...MIN_VALID_ENV, GOLDPAN_LANGUAGE: 'en' };
    const { store, cleanup } = await createStore(bootEnv);
    cleanups.push(cleanup);
    const lang = buildEnvState(store, bootEnv).find((i) => i.key === 'GOLDPAN_LANGUAGE');
    expect(lang?.source).toBe('env');
  });

  test('reports source=default for managed keys absent from bootEnv', async () => {
    // GOLDPAN_AUTH_PASSWORD is a managed key but not in MIN_VALID_ENV; the
    // store reports origin 'default' (no env baseline, no override).
    const bootEnv = { ...MIN_VALID_ENV };
    delete bootEnv.GOLDPAN_AUTH_PASSWORD;
    delete process.env.GOLDPAN_AUTH_PASSWORD;
    const { store, cleanup } = await createStore(bootEnv);
    cleanups.push(cleanup);
    const item = buildEnvState(store, bootEnv).find((i) => i.key === 'GOLDPAN_AUTH_PASSWORD');
    expect(item?.configured).toBe(false);
    expect(item?.source).toBe('default');
    expect(item?.mask).toBe('');
  });

  test('reports source=override after a commit', async () => {
    // After commit, origins[KEY] = 'override' regardless of whether bootEnv
    // also defined it. UI uses this to render the "managed via DB" affordance.
    const bootEnv = { ...MIN_VALID_ENV, GOLDPAN_LANGUAGE: 'en' };
    const { store, cleanup } = await createStore(bootEnv);
    cleanups.push(cleanup);
    const result = await store.commit(new Map([['GOLDPAN_LANGUAGE', 'zh']]));
    expect(result.kind).toBe('ok');
    const lang = buildEnvState(store, bootEnv).find((i) => i.key === 'GOLDPAN_LANGUAGE');
    expect(lang?.source).toBe('override');
    expect(lang?.mask).toBe('zh');
  });

  test('marks baselineDiffers=true when override differs from bootEnv', async () => {
    // bootEnv says 'en'; override says 'zh' → baselineDiffers=true. UI shows
    // the user that removing the override would re-shadow with the .env value.
    const bootEnv = { ...MIN_VALID_ENV, GOLDPAN_LANGUAGE: 'en' };
    const { store, cleanup } = await createStore(bootEnv);
    cleanups.push(cleanup);
    await store.commit(new Map([['GOLDPAN_LANGUAGE', 'zh']]));
    const lang = buildEnvState(store, bootEnv).find((i) => i.key === 'GOLDPAN_LANGUAGE');
    expect(lang?.source).toBe('override');
    expect(lang?.baselineDiffers).toBe(true);
  });

  test('omits baselineDiffers when override matches bootEnv', async () => {
    // bootEnv 'en' + override 'en' → no diff hint (the override is redundant
    // with the baseline; UI doesn't need to flag it).
    const bootEnv = { ...MIN_VALID_ENV, GOLDPAN_LANGUAGE: 'en' };
    const { store, cleanup } = await createStore(bootEnv);
    cleanups.push(cleanup);
    await store.commit(new Map([['GOLDPAN_LANGUAGE', 'en']]));
    const lang = buildEnvState(store, bootEnv).find((i) => i.key === 'GOLDPAN_LANGUAGE');
    expect(lang?.source).toBe('override');
    expect(lang?.baselineDiffers).toBeUndefined();
  });

  test('omits baselineDiffers when bootEnv has no value for the override key', async () => {
    // bootEnv missing GOLDPAN_AUTH_PASSWORD; override sets it. There's no
    // baseline to differ from, so the hint stays off.
    const bootEnv = { ...MIN_VALID_ENV };
    delete bootEnv.GOLDPAN_AUTH_PASSWORD;
    delete process.env.GOLDPAN_AUTH_PASSWORD;
    const { store, cleanup } = await createStore(bootEnv);
    cleanups.push(cleanup);
    await store.commit(new Map([['GOLDPAN_AUTH_PASSWORD', 'newpassword12345']]));
    const item = buildEnvState(store, bootEnv).find((i) => i.key === 'GOLDPAN_AUTH_PASSWORD');
    expect(item?.source).toBe('override');
    expect(item?.baselineDiffers).toBeUndefined();
  });
});

describe('POST /settings/env — patch validation', () => {
  let envBackup: NodeJS.ProcessEnv;
  let cleanups: Array<() => void> = [];
  beforeEach(() => {
    envBackup = { ...process.env };
    cleanups = [];
  });
  afterEach(() => {
    process.env = envBackup;
    for (const c of cleanups) c();
  });

  test('writes the patch via configStore.commit on the happy path (kind=ok)', async () => {
    const bootEnv = { ...MIN_VALID_ENV, GOLDPAN_LANGUAGE: 'en' };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({ patch: { GOLDPAN_LANGUAGE: 'zh' } }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(200);
    const body = resWrap.json() as { kind: string; updatedItems: unknown[] };
    expect(body.kind).toBe('ok');
    // Snapshot reflects the override post-commit.
    expect(store.getSnapshot().origins.get('GOLDPAN_LANGUAGE')).toBe('override');
    expect(store.getSnapshot().config.language).toBe('zh');
  });

  test('ok response includes updatedItems with override-source rows', async () => {
    // updatedItems must reflect the post-commit snapshot:
    //   - non-secret (GOLDPAN_LANGUAGE) → plain value `zh`
    //   - secret (OPENAI_API_KEY, length 24 ≥ 13) → `••••<last4>` = `••••CDEF`
    // Both rows must report `source: 'override'` because they were just
    // persisted to the DB store. baselineDiffers fires for GOLDPAN_LANGUAGE
    // (bootEnv has 'en', override has 'zh') and for OPENAI_API_KEY (bootEnv
    // has 'sk-test-baseline', override has the new value).
    const bootEnv = { ...MIN_VALID_ENV, GOLDPAN_LANGUAGE: 'en' };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({
        patch: { GOLDPAN_LANGUAGE: 'zh', OPENAI_API_KEY: 'sk-proj-1234567890ABCDEF' },
      }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(200);
    const body = resWrap.json() as {
      kind: string;
      updatedItems: {
        key: string;
        configured: boolean;
        source?: string;
        baselineDiffers?: boolean;
        mask: string;
      }[];
      pendingRestartKeys: string[];
    };
    expect(body.kind).toBe('ok');
    expect(body.updatedItems).toHaveLength(2);
    // GOLDPAN_LANGUAGE is in STATIC_RESTART_REQUIRED_KEYS — commit succeeds
    // (DB + process.env updated) but request-scoped server reads + the
    // separate web process still see the boot value until both restart.
    // OPENAI_API_KEY hot-reloads via LlmRegistry generation cache, so it's
    // not listed.
    expect(body.pendingRestartKeys).toEqual(['GOLDPAN_LANGUAGE']);
    const lang = body.updatedItems.find((i) => i.key === 'GOLDPAN_LANGUAGE');
    expect(lang).toMatchObject({
      configured: true,
      source: 'override',
      mask: 'zh',
      baselineDiffers: true,
    });
    const key = body.updatedItems.find((i) => i.key === 'OPENAI_API_KEY');
    expect(key).toMatchObject({
      configured: true,
      source: 'override',
      mask: '••••CDEF',
      baselineDiffers: true,
    });
  });

  test('rejects keys outside MANAGED_ENV_KEYS without writing', async () => {
    const bootEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({ patch: { GOLDPAN_LANGUAGE: 'zh', UNKNOWN_KEY: 'x' } }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(400);
    // configStore.commit returns kind='errors' with per-key path messages.
    const body = resWrap.json() as { kind: string; errors: { path: string }[] };
    expect(body.kind).toBe('errors');
    expect(body.errors.some((e) => e.path === 'UNKNOWN_KEY')).toBe(true);
    // Patch is rejected as a whole — even the whitelisted GOLDPAN_LANGUAGE
    // must not have been persisted as an override.
    expect(store.getSnapshot().origins.get('GOLDPAN_LANGUAGE')).not.toBe('override');
  });

  test('rejects non-string non-null values', async () => {
    const bootEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({ patch: { GOLDPAN_LANGUAGE: 123 } }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(400);
    expect((resWrap.json() as { code: string }).code).toBe('invalid_values');
  });

  test('accepts null value (revert override → baseline)', async () => {
    // null in a patch means "delete this override / revert to env baseline".
    // After a commit then a null commit, origin returns to 'env'.
    const bootEnv = { ...MIN_VALID_ENV, GOLDPAN_LANGUAGE: 'en' };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const handler = createRoutesForTest(store, bootEnv, repo);
    // First save 'zh' as override.
    await store.commit(new Map([['GOLDPAN_LANGUAGE', 'zh']]));
    expect(store.getSnapshot().origins.get('GOLDPAN_LANGUAGE')).toBe('override');
    // Now revert via the route layer.
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({ patch: { GOLDPAN_LANGUAGE: null } }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(200);
    expect(store.getSnapshot().origins.get('GOLDPAN_LANGUAGE')).toBe('env');
    expect(store.getSnapshot().config.language).toBe('en');
  });

  test('rejects empty patch', async () => {
    const bootEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({ patch: {} }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(400);
    expect((resWrap.json() as { code: string }).code).toBe('empty_patch');
  });

  test('rejects malformed body shape (patch not an object)', async () => {
    const bootEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({ patch: 'not-an-object' }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(400);
    expect((resWrap.json() as { code: string }).code).toBe('invalid_input');
  });

  test('accepts custom-provider triple in one patch (BASE_URL + API_KEY_ENV + secret)', async () => {
    // Spec §15.15: settings UI can register a custom LLM provider by saving
    // three keys in one round-trip. The first two match
    // `MANAGED_ENV_PATTERNS`; the third is the user-chosen secret env var
    // declared by `*_API_KEY_ENV`, which becomes managed for THIS patch only
    // via `extractDynamicAllowedEnvNames`. All three must reach the DB store.
    const bootEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({
        patch: {
          GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL: 'https://api.together.xyz/v1',
          GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV: 'TOGETHER_API_KEY',
          TOGETHER_API_KEY: 'tgp-1234567890ABCDEF',
        },
      }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(200);
    expect((resWrap.json() as { kind: string }).kind).toBe('ok');
    const origins = store.getSnapshot().origins;
    expect(origins.get('GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL')).toBe('override');
    expect(origins.get('GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV')).toBe('override');
    expect(origins.get('TOGETHER_API_KEY')).toBe('override');
  });

  test('accepts plugin LLM provider ids supplied by route deps', async () => {
    const bootEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const handler = createRoutesForTest(store, bootEnv, repo, {
      knownLlmProviderIds: ['cohere'],
    });
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({
        patch: {
          GOLDPAN_LLM_CLASSIFIER: 'cohere:command-r-plus',
        },
      }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(200);
    expect((resWrap.json() as { kind: string }).kind).toBe('ok');
    expect(store.getSnapshot().config.llm.classifier).toBe('cohere:command-r-plus');
  });

  test('rejects API_KEY_ENV value with malformed env-name shape', async () => {
    // Defense: a UI bug or hand-crafted client must not be able to declare
    // `_API_KEY_ENV=path/to/secret` and tunnel arbitrary writes. Only
    // `[A-Z][A-Z0-9_]*` shapes pass `extractDynamicAllowedEnvNames`, so the
    // stray `path/to/secret` value here means the would-be secret var is NOT
    // whitelisted, and the patch is rejected.
    const bootEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({
        patch: {
          GOLDPAN_LLM_PROVIDER_X_API_KEY_ENV: 'lower_case_bad',
          lower_case_bad: 'sk-test', // unmanaged → rejection trigger
        },
      }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(400);
    const body = resWrap.json() as { kind: string; errors: { path: string }[] };
    expect(body.kind).toBe('errors');
    expect(body.errors.some((e) => e.path === 'lower_case_bad')).toBe(true);
  });

  test('rejects orphan dynamic API key (no *_API_KEY_ENV declaration in same patch)', async () => {
    // A patch setting `TOGETHER_API_KEY` without also declaring
    // `GOLDPAN_LLM_PROVIDER_X_API_KEY_ENV=TOGETHER_API_KEY` must be rejected —
    // the per-patch allowlist is empty, so `TOGETHER_API_KEY` is unknown.
    const bootEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({
        patch: { TOGETHER_API_KEY: 'tgp-secret' },
      }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(400);
    const body = resWrap.json() as { kind: string; errors: { path: string }[] };
    expect(body.kind).toBe('errors');
    expect(body.errors.some((e) => e.path === 'TOGETHER_API_KEY')).toBe(true);
  });
});

describe('POST /settings/env — pendingRestartKeys', () => {
  let envBackup: NodeJS.ProcessEnv;
  let cleanups: Array<() => void> = [];
  beforeEach(() => {
    envBackup = { ...process.env };
    cleanups = [];
  });
  afterEach(() => {
    process.env = envBackup;
    for (const c of cleanups) c();
  });

  test('returns [] when patch has no restart-required keys (LLM key is hot-reload)', async () => {
    // OPENAI_API_KEY hot-reloads via LlmRegistry generation cache — no restart
    // is needed for the next LLM call to use the new key. Confirms the "happy
    // path" doesn't bother the user with a restart prompt.
    const bootEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({ patch: { OPENAI_API_KEY: 'sk-proj-1234567890NEW' } }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(200);
    const body = resWrap.json() as { kind: string; pendingRestartKeys: string[] };
    expect(body.kind).toBe('ok');
    expect(body.pendingRestartKeys).toEqual([]);
  });

  test('returns [] for search API keys (search plugins read process.env per call → hot-reload)', async () => {
    // Search plugins (Tavily / Serper / Exa / Brave / SearXNG / Google) all
    // read process.env on every executeTool call rather than caching at
    // initialize time. Combined with ConfigStore.commit syncing process.env,
    // a key change takes effect immediately — no restart needed.
    const bootEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({
        patch: {
          TAVILY_API_KEY: 'tvly-test-new-key',
          SERPER_API_KEY: 'serper-test-new-key',
        },
      }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(200);
    const body = resWrap.json() as { kind: string; pendingRestartKeys: string[] };
    expect(body.kind).toBe('ok');
    expect(body.pendingRestartKeys).toEqual([]);
  });

  test('validates generic contribution env values before committing', async () => {
    const contribution: PluginSettingsContribution = {
      pluginId: 'tool-search-google',
      group: 'search',
      branding: { name: 'Google' },
      schema: z.object({
        hourlyLimit: z.number().int().min(1).max(1000).optional(),
      }),
      fields: [
        {
          name: 'hourlyLimit',
          kind: 'number',
          envKey: 'GOLDPAN_GOOGLE_SEARCH_HOURLY_LIMIT',
          label: 'Hourly limit',
        },
      ],
    };
    const bootEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    store.setPluginEnvKeys(['GOLDPAN_GOOGLE_SEARCH_HOURLY_LIMIT']);
    const handler = createRoutesForTest(store, bootEnv, repo, {
      pluginEnvKeys: ['GOLDPAN_GOOGLE_SEARCH_HOURLY_LIMIT'],
      pluginEnvSchemas: [buildContributionEnvSchema(contribution)],
    });
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({
        patch: {
          GOLDPAN_GOOGLE_SEARCH_HOURLY_LIMIT: 'abc',
        },
      }),
    });

    await handler(ctx);

    expect(resWrap.status()).toBe(400);
    const body = resWrap.json() as { kind: string; errors: Array<{ path: string }> };
    expect(body.kind).toBe('errors');
    expect(body.errors[0]?.path).toBe('GOLDPAN_GOOGLE_SEARCH_HOURLY_LIMIT');
  });

  test('does not require untouched generic contribution fields when saving unrelated keys', async () => {
    const contribution: PluginSettingsContribution = {
      pluginId: 'required-plugin',
      group: 'search',
      branding: { name: 'Required Plugin' },
      schema: z.object({
        apiKey: z.string().min(1),
      }),
      fields: [
        {
          name: 'apiKey',
          kind: 'secret',
          envKey: 'REQUIRED_PLUGIN_API_KEY',
          label: 'API Key',
          required: true,
        },
      ],
    };
    const bootEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    store.setPluginEnvKeys(['REQUIRED_PLUGIN_API_KEY']);
    const handler = createRoutesForTest(store, bootEnv, repo, {
      pluginEnvKeys: ['REQUIRED_PLUGIN_API_KEY'],
      pluginEnvSchemas: [buildContributionEnvSchema(contribution)],
    });
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({
        patch: {
          GOLDPAN_LANGUAGE: 'zh',
        },
      }),
    });

    await handler(ctx);

    expect(resWrap.status()).toBe(200);
    const body = resWrap.json() as { kind: string };
    expect(body.kind).toBe('ok');
  });

  test('lists GOLDPAN_AUTH_PASSWORD when committed (web middleware reads boot value)', async () => {
    // GOLDPAN_AUTH_PASSWORD lands in DB + process.env, but main.ts reads
    // `handle.config.authPassword` (frozen at boot) for request auth, and
    // the separate web Node process never sees the override. Surface the key
    // so the UI can warn that BOTH server + web need restarting.
    const bootEnv: NodeJS.ProcessEnv = { ...MIN_VALID_ENV };
    delete bootEnv.GOLDPAN_AUTH_PASSWORD;
    delete process.env.GOLDPAN_AUTH_PASSWORD;
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({ patch: { GOLDPAN_AUTH_PASSWORD: 'newpassword12345' } }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(200);
    const body = resWrap.json() as { kind: string; pendingRestartKeys: string[] };
    expect(body.kind).toBe('ok');
    expect(body.pendingRestartKeys).toEqual(['GOLDPAN_AUTH_PASSWORD']);
  });

  test('lists every restart-required key in the patch in original order', async () => {
    // Multi-key patch: pendingRestartKeys must include every restart-required
    // entry, leaving hot-reload entries (OPENAI_API_KEY) out. Order matches
    // patch iteration so the UI can render predictable copy.
    const bootEnv: NodeJS.ProcessEnv = { ...MIN_VALID_ENV, GOLDPAN_LANGUAGE: 'en' };
    delete bootEnv.GOLDPAN_AUTH_PASSWORD;
    delete process.env.GOLDPAN_AUTH_PASSWORD;
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({
        patch: {
          GOLDPAN_LANGUAGE: 'zh',
          OPENAI_API_KEY: 'sk-proj-1234567890NEW',
          GOLDPAN_AUTH_PASSWORD: 'newpassword12345',
        },
      }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(200);
    const body = resWrap.json() as { kind: string; pendingRestartKeys: string[] };
    expect(body.kind).toBe('ok');
    expect(body.pendingRestartKeys).toEqual(['GOLDPAN_LANGUAGE', 'GOLDPAN_AUTH_PASSWORD']);
  });

  test('invokes onPendingRestart with the same keys when patch contains restart-required entries', async () => {
    // Wire-up contract: main.ts's process-lifetime Set is populated via
    // `onPendingRestart`. This test pins the callback shape — the callback
    // fires AT MOST once per commit (with the full filtered list, not one
    // call per key) so main.ts can do `for (const k of keys) set.add(k)`
    // in a single batch.
    const bootEnv = { ...MIN_VALID_ENV, GOLDPAN_LANGUAGE: 'en' };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const captured: string[][] = [];
    const handler = createRoutesForTest(store, bootEnv, repo, {
      onPendingRestart: (keys) => captured.push([...keys]),
    });
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({
        patch: {
          GOLDPAN_LANGUAGE: 'zh',
          OPENAI_API_KEY: 'sk-proj-1234567890NEW',
        },
      }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(200);
    const body = resWrap.json() as { kind: string; pendingRestartKeys: string[] };
    expect(body.kind).toBe('ok');
    expect(body.pendingRestartKeys).toEqual(['GOLDPAN_LANGUAGE']);
    // Callback fires once with the same filtered list — OPENAI_API_KEY is
    // hot-reload so it does not appear here either.
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual(['GOLDPAN_LANGUAGE']);
  });

  test('does not invoke onPendingRestart when patch has no restart-required keys', async () => {
    // Hot-reload-only patches must not pollute the process-lifetime Set —
    // otherwise /health would falsely warn "user saved boot-only keys" after
    // every API-key edit.
    const bootEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const captured: string[][] = [];
    const handler = createRoutesForTest(store, bootEnv, repo, {
      onPendingRestart: (keys) => captured.push([...keys]),
    });
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({ patch: { OPENAI_API_KEY: 'sk-proj-1234567890NEW' } }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(200);
    expect(captured).toEqual([]);
  });

  test('accepts all four tracking knobs as hot-reloadable (no restart required)', async () => {
    // Regression for PR2 review C-3: GOLDPAN_TRACKING_MIN_RULE_INTERVAL and
    // GOLDPAN_TRACKING_MAX_RESULTS_PER_SEARCH must both be in MANAGED_ENV_KEYS
    // for tracking/src/index.ts's per-tick read to actually see commit() writes
    // (otherwise process.env stays at boot value and the "hot reload" code path
    // is dead). They also must NOT be in STATIC_RESTART_REQUIRED_KEYS — POLL /
    // DAILY / MIN_RULE_INTERVAL / MAX_RESULTS feed scheduler decisions per-tick,
    // not boot-time wiring, so they hot-reload by design (only _SCHEDULER_ENABLED
    // is boot-only, since enabling/disabling spins up the scheduler instance).
    const bootEnv: NodeJS.ProcessEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({
        patch: {
          GOLDPAN_TRACKING_POLL_INTERVAL: '120',
          GOLDPAN_TRACKING_DAILY_SEARCH_LIMIT: '50',
          GOLDPAN_TRACKING_MIN_RULE_INTERVAL: '30',
          GOLDPAN_TRACKING_MAX_RESULTS_PER_SEARCH: '5',
        },
      }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(200);
    const body = resWrap.json() as { kind: string; pendingRestartKeys: string[] };
    // All four whitelisted → commit accepts (kind='ok') instead of returning
    // a per-key 'errors' for any unmanaged member.
    expect(body.kind).toBe('ok');
    // None of the four are in STATIC_RESTART_REQUIRED_KEYS → pendingRestartKeys
    // is empty for this patch (caller doesn't see a restart prompt).
    expect(body.pendingRestartKeys).toEqual([]);
  });

  test('flags boot-only scheduler/embedding enable toggles as restart-required', async () => {
    // GOLDPAN_DIGEST_ENABLED / GOLDPAN_TRACKING_SCHEDULER_ENABLED /
    // GOLDPAN_EMBEDDING_ENABLED 的 effect 全部在 bootstrap 期一次性 spin up
    // (sqlite-vec load + vec0 表、tracking scheduler、digest schedulers)。
    // 用户在 settings UI 把它们从 false 翻 true，commit 写入 DB + process.env
    // 之后这些子系统**仍然不会启动**，必须重启才生效 — UI 必须给重启提示。
    const bootEnv: NodeJS.ProcessEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({
        patch: {
          GOLDPAN_DIGEST_ENABLED: 'true',
          GOLDPAN_TRACKING_SCHEDULER_ENABLED: 'true',
          GOLDPAN_EMBEDDING_ENABLED: 'true',
        },
      }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(200);
    const body = resWrap.json() as { kind: string; pendingRestartKeys: string[] };
    expect(body.kind).toBe('ok');
    expect(body.pendingRestartKeys).toEqual([
      'GOLDPAN_DIGEST_ENABLED',
      'GOLDPAN_TRACKING_SCHEDULER_ENABLED',
      'GOLDPAN_EMBEDDING_ENABLED',
    ]);
  });

  test('committing the boot value back resolves a previously pending key', async () => {
    // Regression for review H-1: pendingRestartKeys / onPendingRestart used to
    // be add-only — every commit of a restart-required key flagged it forever.
    // After this fix the route compares post-commit process.env[key] against
    // the boot baseline; equality means "back to baseline, no restart needed"
    // and routes the key to `onResolveRestart` so main.ts can drop it from
    // the lifetime Set. Without this, /health would falsely report a key as
    // pending even after the user reverted.
    const bootEnv = { ...MIN_VALID_ENV, GOLDPAN_LANGUAGE: 'en' };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const pendingCalls: string[][] = [];
    const resolvedCalls: string[][] = [];
    const handler = createRoutesForTest(store, bootEnv, repo, {
      onPendingRestart: (keys) => pendingCalls.push([...keys]),
      onResolveRestart: (keys) => resolvedCalls.push([...keys]),
    });

    // Step 1: divert from boot — pending fires, resolve does not.
    {
      const { ctx, resWrap } = buildCtx({
        method: 'POST',
        pathTail: 'env',
        body: JSON.stringify({ patch: { GOLDPAN_LANGUAGE: 'zh' } }),
      });
      await handler(ctx);
      expect(resWrap.status()).toBe(200);
      const body = resWrap.json() as { kind: string; pendingRestartKeys: string[] };
      expect(body.pendingRestartKeys).toEqual(['GOLDPAN_LANGUAGE']);
    }
    expect(pendingCalls).toEqual([['GOLDPAN_LANGUAGE']]);
    expect(resolvedCalls).toEqual([]);

    // Step 2: commit boot value back — resolve fires, pending does not.
    {
      const { ctx, resWrap } = buildCtx({
        method: 'POST',
        pathTail: 'env',
        body: JSON.stringify({ patch: { GOLDPAN_LANGUAGE: 'en' } }),
      });
      await handler(ctx);
      expect(resWrap.status()).toBe(200);
      const body = resWrap.json() as { kind: string; pendingRestartKeys: string[] };
      // Response also reports empty — matches the lifetime-set transition.
      expect(body.pendingRestartKeys).toEqual([]);
    }
    expect(pendingCalls).toEqual([['GOLDPAN_LANGUAGE']]); // still just the first call
    expect(resolvedCalls).toEqual([['GOLDPAN_LANGUAGE']]);
  });

  test('reset (patch=null) on a restart-required override resolves the pending key', async () => {
    // Reset path: patch `{ KEY: null }` deletes the DB override; commit reapplies
    // the boot env baseline to process.env. Since post-commit effective ===
    // boot, the route should route the key to onResolveRestart, not
    // onPendingRestart. This is the second half of the H-1 fix — the original
    // PR2 implementation classified the patch by key name only, so resetting
    // a previously-overridden GOLDPAN_LANGUAGE would have re-flagged it as
    // pending and the lifetime Set would never lose the entry until restart.
    const bootEnv = { ...MIN_VALID_ENV, GOLDPAN_LANGUAGE: 'en' };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    // Pre-stage an override so reset has something to revert.
    await store.commit(new Map([['GOLDPAN_LANGUAGE', 'zh']]));
    const pendingCalls: string[][] = [];
    const resolvedCalls: string[][] = [];
    const handler = createRoutesForTest(store, bootEnv, repo, {
      onPendingRestart: (keys) => pendingCalls.push([...keys]),
      onResolveRestart: (keys) => resolvedCalls.push([...keys]),
    });
    const { ctx, resWrap } = buildCtx({
      method: 'POST',
      pathTail: 'env',
      body: JSON.stringify({ patch: { GOLDPAN_LANGUAGE: null } }),
    });
    await handler(ctx);
    expect(resWrap.status()).toBe(200);
    const body = resWrap.json() as { kind: string; pendingRestartKeys: string[] };
    expect(body.kind).toBe('ok');
    expect(body.pendingRestartKeys).toEqual([]);
    expect(pendingCalls).toEqual([]);
    expect(resolvedCalls).toEqual([['GOLDPAN_LANGUAGE']]);
  });

  test('resolves a restart-required key set via DB override but absent from .env (boot-effective baseline)', async () => {
    // Self-deploy repro: a restart-required key configured ONLY through a DB
    // override, never written to `.env`. `bootEnv` (pre-merge `.env`) has no
    // entry for it, but `bootEffectiveEnv` — what the process actually loaded
    // at boot (.env + DB overlaid) — carries the override's value. Diverting
    // from that value flags pending; reverting to it must resolve. Pre-fix the
    // route compared against `bootEnv` (=''), so the revert ('false' !== '')
    // stayed pending forever and /health nagged about a restart no longer
    // needed. The comparison now uses bootEffectiveEnv.
    const KEY = 'GOLDPAN_SSRF_VALIDATION_ENABLED';
    const bootEnv = { ...MIN_VALID_ENV }; // .env does NOT define SSRF
    const bootEffectiveEnv = { ...MIN_VALID_ENV, [KEY]: 'false' }; // booted with DB override 'false'
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const pendingCalls: string[][] = [];
    const resolvedCalls: string[][] = [];
    const handler = createRoutesForTest(store, bootEnv, repo, {
      bootEffectiveEnv,
      onPendingRestart: (keys) => pendingCalls.push([...keys]),
      onResolveRestart: (keys) => resolvedCalls.push([...keys]),
    });

    // Step 1: divert from the boot-effective value → pending.
    {
      const { ctx, resWrap } = buildCtx({
        method: 'POST',
        pathTail: 'env',
        body: JSON.stringify({ patch: { [KEY]: 'true' } }),
      });
      await handler(ctx);
      expect(resWrap.status()).toBe(200);
      const body = resWrap.json() as { pendingRestartKeys: string[] };
      expect(body.pendingRestartKeys).toEqual([KEY]);
    }
    expect(pendingCalls).toEqual([[KEY]]);
    expect(resolvedCalls).toEqual([]);

    // Step 2: revert to the boot-effective value → resolved (pre-fix: stayed pending).
    {
      const { ctx, resWrap } = buildCtx({
        method: 'POST',
        pathTail: 'env',
        body: JSON.stringify({ patch: { [KEY]: 'false' } }),
      });
      await handler(ctx);
      expect(resWrap.status()).toBe(200);
      const body = resWrap.json() as { pendingRestartKeys: string[] };
      expect(body.pendingRestartKeys).toEqual([]);
    }
    expect(pendingCalls).toEqual([[KEY]]); // still just the first divert
    expect(resolvedCalls).toEqual([[KEY]]);
  });
});

describe('GET /settings/export-overrides', () => {
  let envBackup: NodeJS.ProcessEnv;
  let cleanups: Array<() => void> = [];
  beforeEach(() => {
    envBackup = { ...process.env };
    cleanups = [];
  });
  afterEach(() => {
    process.env = envBackup;
    for (const c of cleanups) c();
  });

  test('returns header + sorted overrides as text/plain', async () => {
    const bootEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    await store.commit(
      new Map([
        ['OPENAI_API_KEY', 'sk-export-1234567890ab'],
        ['GOLDPAN_LLM_CLASSIFIER', 'openai:gpt-4o'],
      ]),
    );
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({ method: 'GET', pathTail: 'export-overrides' });
    await handler(ctx);
    expect(resWrap.status()).toBe(200);
    expect(resWrap.header('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(resWrap.header('Cache-Control')).toBe('no-store, private');
    const body = resWrap.text();
    expect(body).toContain('# Goldpan UI overrides — exported on');
    expect(body).toContain('GOLDPAN_LLM_CLASSIFIER=openai:gpt-4o');
    expect(body).toContain('OPENAI_API_KEY=sk-export-1234567890ab');
    // Sorted alphabetically: GOLDPAN_LLM_CLASSIFIER < OPENAI_API_KEY
    const idxClassifier = body.indexOf('GOLDPAN_LLM_CLASSIFIER');
    const idxKey = body.indexOf('OPENAI_API_KEY');
    expect(idxClassifier).toBeLessThan(idxKey);
  });

  test('returns header-only body when no overrides exist', async () => {
    const bootEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({ method: 'GET', pathTail: 'export-overrides' });
    await handler(ctx);
    expect(resWrap.status()).toBe(200);
    const body = resWrap.text();
    // Header lines + trailing blank line. No KEY=value rows.
    const valueLines = body.split('\n').filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l));
    expect(valueLines).toEqual([]);
  });

  test('quotes values containing whitespace', async () => {
    const bootEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    // Drive the repo directly — `configStore.commit` would route through
    // route-layer SSRF + value validation that rejects whitespace, but the
    // export endpoint doesn't re-validate (it just dumps what's persisted).
    // The legitimate case for whitespace quoting is values like prompts /
    // language settings; faking via the repo keeps the test focused on
    // `escapeEnvValue` shape rather than hauling in a non-URL fixture.
    repo.upsert('GOLDPAN_LANGUAGE', 'value with space');
    // No-op against ConfigStore — but the repo write is what export reads.
    void store;
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({ method: 'GET', pathTail: 'export-overrides' });
    await handler(ctx);
    const body = resWrap.text();
    expect(body).toContain('GOLDPAN_LANGUAGE="value with space"');
  });

  test('single-quotes values that would otherwise trigger shell expansion', async () => {
    const bootEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    repo.upsert('OPENAI_API_KEY', 'pa$$word`whoami`');
    void store;
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({ method: 'GET', pathTail: 'export-overrides' });
    await handler(ctx);
    const body = resWrap.text();
    expect(body).toContain("OPENAI_API_KEY='pa$$word`whoami`'");
  });

  test('shell-escapes embedded single quotes when single-quoting', async () => {
    const bootEnv = { ...MIN_VALID_ENV };
    const { store, repo, cleanup } = await createStoreAndRepo(bootEnv);
    cleanups.push(cleanup);
    repo.upsert('OPENAI_API_KEY', "don't-$expand");
    void store;
    const handler = createRoutesForTest(store, bootEnv, repo);
    const { ctx, resWrap } = buildCtx({ method: 'GET', pathTail: 'export-overrides' });
    await handler(ctx);
    const body = resWrap.text();
    expect(body).toContain(`OPENAI_API_KEY='don'"'"'t-$expand'`);
  });
});
