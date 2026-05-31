import { getRawDatabase } from '@goldpan/core/db';
import { SqliteMetadataRepository } from '@goldpan/core/db/repositories';
import { initI18n, resetI18n } from '@goldpan/core/i18n';
import type { PluginContext, PluginRegistry } from '@goldpan/core/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goldpanPlugin } from '../src/index.js';
import { createMutableTestConfigStore } from './fixtures/plugin-context.js';
import { makeTestDbWithMetadata } from './fixtures/seed.js';

// initialize() requires callLlm when digest is enabled, but the seed path we're
// testing in postInit doesn't actually invoke it.
const mockCallLlm = vi.fn(async () => ({
  headline: 'ok',
  bullets: ['a'],
  closing: '',
}));

function fakeRegistry(): PluginRegistry {
  const services = new Map<string, unknown>();
  return {
    registerService: (name: string, svc: unknown) => services.set(name, svc),
    getService: (name: string) => services.get(name),
  } as unknown as PluginRegistry;
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

describe('digest plugin postInit seed (wizard first-run)', () => {
  // Each test creates its own DB; afterEach destroys plugin to reset module state.
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

  it('seeds wizard_default preset when metadata exists, then consumes the key', async () => {
    const { db, cleanup } = makeTestDbWithMetadata();
    cleanupFn = cleanup;
    const metadataRepo = new SqliteMetadataRepository(db);
    metadataRepo.set(
      'digest_initial_preset',
      JSON.stringify({ modules: ['captures', 'ai_summary'], maxItems: 5 }),
    );

    const { logger } = makeLogger();
    const pluginRegistry = fakeRegistry();
    const ctx = {
      logger,
      pluginConfig: {},
      configStore: createMutableTestConfigStore(),
    } as unknown as PluginContext;
    const capabilities = {
      db,
      pluginRegistry,
      callLlm: mockCallLlm,
      config: { digest: { enabled: true } },
    };

    await goldpanPlugin.initialize?.(ctx, capabilities as never);
    await goldpanPlugin.postInit?.(ctx, capabilities as never);

    const raw = getRawDatabase(db);
    const wizardRow = raw
      .prepare(
        `SELECT name, slots_json, is_default, include_ai_summary
         FROM digest_presets WHERE channel = 'web' AND name = 'wizard_default'`,
      )
      .get() as
      | { name: string; slots_json: string; is_default: number; include_ai_summary: number }
      | undefined;

    expect(wizardRow).toBeDefined();
    expect(JSON.parse(wizardRow!.slots_json)).toEqual(['captures', 'ai_summary']);
    expect(wizardRow!.is_default).toBe(1);
    expect(wizardRow!.include_ai_summary).toBe(1);

    // The previous default (seeded by initialize's seedDefaultPresets) should
    // have been demoted: our wizard preset is the only is_default=1 row for 'web'.
    const defaults = raw
      .prepare(`SELECT name FROM digest_presets WHERE channel = 'web' AND is_default = 1`)
      .all() as Array<{ name: string }>;
    expect(defaults.map((d) => d.name)).toEqual(['wizard_default']);

    // One-shot: the metadata key was consumed.
    expect(metadataRepo.get('digest_initial_preset')).toBeUndefined();
  });

  it('skips silently when no metadata seed exists (no wizard_default row)', async () => {
    const { db, cleanup } = makeTestDbWithMetadata();
    cleanupFn = cleanup;

    const { logger, errors } = makeLogger();
    const pluginRegistry = fakeRegistry();
    const ctx = {
      logger,
      pluginConfig: {},
      configStore: createMutableTestConfigStore(),
    } as unknown as PluginContext;
    const capabilities = {
      db,
      pluginRegistry,
      callLlm: mockCallLlm,
      config: { digest: { enabled: true } },
    };

    await goldpanPlugin.initialize?.(ctx, capabilities as never);
    await goldpanPlugin.postInit?.(ctx, capabilities as never);

    const raw = getRawDatabase(db);
    const wizardRow = raw
      .prepare(`SELECT 1 FROM digest_presets WHERE channel = 'web' AND name = 'wizard_default'`)
      .get();
    expect(wizardRow).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('consumes the metadata key even when JSON is malformed (no infinite-retry)', async () => {
    const { db, cleanup } = makeTestDbWithMetadata();
    cleanupFn = cleanup;
    const metadataRepo = new SqliteMetadataRepository(db);
    metadataRepo.set('digest_initial_preset', 'not-json');

    const { logger } = makeLogger();
    const pluginRegistry = fakeRegistry();
    const ctx = {
      logger,
      pluginConfig: {},
      configStore: createMutableTestConfigStore(),
    } as unknown as PluginContext;
    const capabilities = {
      db,
      pluginRegistry,
      callLlm: mockCallLlm,
      config: { digest: { enabled: true } },
    };

    await goldpanPlugin.initialize?.(ctx, capabilities as never);
    await goldpanPlugin.postInit?.(ctx, capabilities as never);

    // No wizard preset created because parsing failed…
    const raw = getRawDatabase(db);
    const wizardRow = raw
      .prepare(`SELECT 1 FROM digest_presets WHERE channel = 'web' AND name = 'wizard_default'`)
      .get();
    expect(wizardRow).toBeUndefined();
    // …but the metadata key was still consumed so we don't retry every boot.
    expect(metadataRepo.get('digest_initial_preset')).toBeUndefined();
  });

  it('idempotent on re-run: second postInit with the same metadata catches unique-name and consumes the key', async () => {
    const { db, cleanup } = makeTestDbWithMetadata();
    cleanupFn = cleanup;
    const metadataRepo = new SqliteMetadataRepository(db);
    metadataRepo.set(
      'digest_initial_preset',
      JSON.stringify({ modules: ['captures'], maxItems: 5 }),
    );

    const { logger } = makeLogger();
    const pluginRegistry = fakeRegistry();
    const ctx = {
      logger,
      pluginConfig: {},
      configStore: createMutableTestConfigStore(),
    } as unknown as PluginContext;
    const capabilities = {
      db,
      pluginRegistry,
      callLlm: mockCallLlm,
      config: { digest: { enabled: true } },
    };

    await goldpanPlugin.initialize?.(ctx, capabilities as never);
    await goldpanPlugin.postInit?.(ctx, capabilities as never);
    // First run consumed the key. Re-set it to simulate a retried wizard run
    // where the previous wizard_default preset still exists (unique collision).
    metadataRepo.set(
      'digest_initial_preset',
      JSON.stringify({ modules: ['captures'], maxItems: 5 }),
    );

    // Re-run postInit — must not throw; key must be consumed.
    await expect(goldpanPlugin.postInit?.(ctx, capabilities as never)).resolves.toBeUndefined();
    expect(metadataRepo.get('digest_initial_preset')).toBeUndefined();
  });

  it('does not run seed when digest is disabled (configState.enabled=false)', async () => {
    const { db, cleanup } = makeTestDbWithMetadata();
    cleanupFn = cleanup;
    const metadataRepo = new SqliteMetadataRepository(db);
    metadataRepo.set(
      'digest_initial_preset',
      JSON.stringify({ modules: ['captures'], maxItems: 5 }),
    );

    const { logger } = makeLogger();
    const pluginRegistry = fakeRegistry();
    const ctx = {
      logger,
      pluginConfig: {},
      configStore: createMutableTestConfigStore(),
    } as unknown as PluginContext;
    const capabilities = {
      db,
      pluginRegistry,
      config: { digest: { enabled: false } },
    };

    await goldpanPlugin.initialize?.(ctx, capabilities as never);
    await goldpanPlugin.postInit?.(ctx, capabilities as never);

    // Disabled: digest tables don't exist, no preset created, key NOT consumed
    // (a future enable+restart will pick it up).
    expect(metadataRepo.get('digest_initial_preset')).toBeDefined();
  });
});
