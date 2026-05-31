import { getRawDatabase } from '@goldpan/core/db';
import { SqliteMetadataRepository } from '@goldpan/core/db/repositories';
import { NOW_MS_SQL } from '@goldpan/core/db/sql-fragments';
import { initI18n, resetI18n } from '@goldpan/core/i18n';
import type { PluginContext, PluginRegistry } from '@goldpan/core/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDB } from '../../../packages/core/tests/helpers/test-db';
import { goldpanPlugin } from '../src/index.js';

// initialize() requires callLlm + submitInput, but the seed path we're testing
// in postInit doesn't actually invoke either of them.
const mockCallLlm = vi.fn(async () => ({}) as never);
const mockSubmitInput = vi.fn(
  async () => ({ status: 'accepted', taskId: 1, sourceId: 1 }) as never,
);

function fakeRegistry(): PluginRegistry {
  const services = new Map<string, unknown>();
  return {
    registerService: <T>(name: string, svc: T) => {
      services.set(name, svc);
      return svc;
    },
    getService: <T>(name: string) => services.get(name) as T | undefined,
    // tracking's createInterest takes a `toolProvider` ⇒ resolveToolProvider
    // is consulted only when the seed actually carries a `toolProvider`. None
    // of the test inputs do, so a stub returning undefined is fine.
    resolveToolProvider: () => undefined,
  } as unknown as PluginRegistry;
}

// The seed/postInit path doesn't read configStore — tracking only invokes
// `configStore.onChange` for observability logging. A no-op stub keeps these
// tests focused on the seed contract without spinning up a real ConfigStore.
function stubConfigStore() {
  return {
    getSnapshot: () => ({ config: {}, origins: new Map(), generation: 0 }),
    commit: async () => ({ kind: 'ok' as const, snapshot: {} as never }),
    onChange: () => () => {},
    refresh: async () => ({ config: {}, origins: new Map(), generation: 0 }) as never,
    setPluginEnvKeys: () => {},
  } as unknown as PluginContext['configStore'];
}

function makeLogger(): {
  logger: PluginContext['logger'];
  warns: Array<{ msg: string; meta: unknown }>;
  errors: Array<{ msg: string; meta: unknown }>;
} {
  const warns: Array<{ msg: string; meta: unknown }> = [];
  const errors: Array<{ msg: string; meta: unknown }> = [];
  const logger = {
    warn: (msg: string, meta?: unknown) => warns.push({ msg, meta }),
    error: (msg: string, meta?: unknown) => errors.push({ msg, meta }),
    info: () => {},
    debug: () => {},
    silly: () => {},
    trace: () => {},
    fatal: () => {},
    getSubLogger: () => logger,
  } as unknown as PluginContext['logger'];
  return { logger, warns, errors };
}

describe('tracking plugin postInit seed (wizard first-run)', () => {
  let cleanupFn: (() => void) | undefined;

  beforeEach(() => {
    cleanupFn = undefined;
    resetI18n();
    initI18n('en');
  });

  afterEach(async () => {
    try {
      await goldpanPlugin.destroy?.();
    } catch {
      /* best-effort */
    }
    cleanupFn?.();
  });

  it('seeds rules when metadata exists and no existing interests; consumes the key', async () => {
    const { db, cleanup } = createTestDB();
    cleanupFn = cleanup;
    const metadataRepo = new SqliteMetadataRepository(db);
    metadataRepo.set(
      'tracking_initial_rules',
      JSON.stringify([
        { name: 'claude code', searchQueries: ['claude code', 'claude opus'], intervalMinutes: 60 },
        { name: 'gpt', searchQueries: ['gpt-5'], intervalMinutes: 1440 },
      ]),
    );

    const { logger, errors } = makeLogger();
    const pluginRegistry = fakeRegistry();
    const ctx = {
      logger,
      pluginConfig: {},
      configStore: stubConfigStore(),
    } as unknown as PluginContext;
    const capabilities = {
      db,
      pluginRegistry,
      submitInput: mockSubmitInput,
      callLlm: mockCallLlm,
      config: {} as never,
    };

    await goldpanPlugin.initialize?.(ctx, capabilities as never);
    await goldpanPlugin.postInit?.(ctx, capabilities as never);

    const raw = getRawDatabase(db);
    const rows = raw
      .prepare(`SELECT name, interval_minutes, enabled FROM tracking_rules ORDER BY name`)
      .all() as Array<{ name: string; interval_minutes: number; enabled: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.name).toBe('claude code');
    expect(rows[0]?.enabled).toBe(1);
    expect(rows[1]?.name).toBe('gpt');
    expect(rows[1]?.interval_minutes).toBe(1440);

    // One-shot: the metadata key was consumed.
    expect(metadataRepo.get('tracking_initial_rules')).toBeUndefined();
    // Sanity: no errors were logged.
    expect(errors).toEqual([]);
  });

  it('skips seeding when interests already exist (still consumes key)', async () => {
    const { db, cleanup } = createTestDB();
    cleanupFn = cleanup;

    const { logger } = makeLogger();
    const pluginRegistry = fakeRegistry();
    const ctx = {
      logger,
      pluginConfig: {},
      configStore: stubConfigStore(),
    } as unknown as PluginContext;
    const capabilities = {
      db,
      pluginRegistry,
      submitInput: mockSubmitInput,
      callLlm: mockCallLlm,
      config: {} as never,
    };

    // Initialize first so `tracking_rules` table exists, then insert a
    // pre-existing rule directly (driving service.createInterest would also
    // work but the raw insert keeps the test minimal).
    await goldpanPlugin.initialize?.(ctx, capabilities as never);
    const raw = getRawDatabase(db);
    raw
      .prepare(
        `INSERT INTO tracking_rules (name, search_queries_json, interval_minutes, enabled, status, created_at, updated_at)
         VALUES ('preexisting', '["foo"]', 60, 1, 'idle', ${NOW_MS_SQL}, ${NOW_MS_SQL})`,
      )
      .run();

    const metadataRepo = new SqliteMetadataRepository(db);
    metadataRepo.set(
      'tracking_initial_rules',
      JSON.stringify([{ name: 'wizard rule', searchQueries: ['x'], intervalMinutes: 60 }]),
    );

    await goldpanPlugin.postInit?.(ctx, capabilities as never);

    const rows = raw.prepare(`SELECT name FROM tracking_rules ORDER BY name`).all() as Array<{
      name: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('preexisting');
    expect(metadataRepo.get('tracking_initial_rules')).toBeUndefined();
  });

  it('skips silently when no metadata seed (no rule rows; key not present)', async () => {
    const { db, cleanup } = createTestDB();
    cleanupFn = cleanup;

    const { logger } = makeLogger();
    const pluginRegistry = fakeRegistry();
    const ctx = {
      logger,
      pluginConfig: {},
      configStore: stubConfigStore(),
    } as unknown as PluginContext;
    const capabilities = {
      db,
      pluginRegistry,
      submitInput: mockSubmitInput,
      callLlm: mockCallLlm,
      config: {} as never,
    };

    await goldpanPlugin.initialize?.(ctx, capabilities as never);
    await goldpanPlugin.postInit?.(ctx, capabilities as never);

    const raw = getRawDatabase(db);
    const rows = raw.prepare(`SELECT 1 FROM tracking_rules`).all();
    expect(rows).toHaveLength(0);
  });

  it('consumes the metadata key even when JSON is malformed (no infinite-retry)', async () => {
    const { db, cleanup } = createTestDB();
    cleanupFn = cleanup;
    const metadataRepo = new SqliteMetadataRepository(db);
    metadataRepo.set('tracking_initial_rules', 'not-json');

    const { logger, errors } = makeLogger();
    const pluginRegistry = fakeRegistry();
    const ctx = {
      logger,
      pluginConfig: {},
      configStore: stubConfigStore(),
    } as unknown as PluginContext;
    const capabilities = {
      db,
      pluginRegistry,
      submitInput: mockSubmitInput,
      callLlm: mockCallLlm,
      config: {} as never,
    };

    await goldpanPlugin.initialize?.(ctx, capabilities as never);
    await goldpanPlugin.postInit?.(ctx, capabilities as never);

    // No rule was inserted because parsing failed…
    const raw = getRawDatabase(db);
    const rows = raw.prepare(`SELECT 1 FROM tracking_rules`).all();
    expect(rows).toHaveLength(0);
    // …but the metadata key was still consumed so we don't retry every boot.
    expect(metadataRepo.get('tracking_initial_rules')).toBeUndefined();
    // The parse failure must surface in the error log so operators can
    // diagnose it without going through the metadata table by hand.
    expect(errors.length).toBeGreaterThan(0);
  });

  it('skips a single malformed rule but still seeds the rest', async () => {
    const { db, cleanup } = createTestDB();
    cleanupFn = cleanup;
    const metadataRepo = new SqliteMetadataRepository(db);
    metadataRepo.set(
      'tracking_initial_rules',
      JSON.stringify([
        // First rule is malformed: missing searchQueries.
        { name: 'broken', intervalMinutes: 60 },
        // Second rule is valid and should still be inserted.
        { name: 'ok', searchQueries: ['valid'], intervalMinutes: 60 },
      ]),
    );

    const { logger, warns } = makeLogger();
    const pluginRegistry = fakeRegistry();
    const ctx = {
      logger,
      pluginConfig: {},
      configStore: stubConfigStore(),
    } as unknown as PluginContext;
    const capabilities = {
      db,
      pluginRegistry,
      submitInput: mockSubmitInput,
      callLlm: mockCallLlm,
      config: {} as never,
    };

    await goldpanPlugin.initialize?.(ctx, capabilities as never);
    await goldpanPlugin.postInit?.(ctx, capabilities as never);

    const raw = getRawDatabase(db);
    const rows = raw.prepare(`SELECT name FROM tracking_rules`).all() as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('ok');
    // Malformed rule was warned about, not error-logged (so it doesn't
    // pollute alerting), and the metadata key was still consumed.
    expect(warns.length).toBeGreaterThan(0);
    expect(metadataRepo.get('tracking_initial_rules')).toBeUndefined();
  });
});
