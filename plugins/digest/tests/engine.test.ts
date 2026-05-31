import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDigestTables } from '../src/db.js';
import { DigestEngine } from '../src/engine.js';
import { makeTestDbWithMetadata, seedDigestFixture } from './fixtures/seed.js';

const DATE = '2026-04-18';

function makeEngine() {
  const { db, cleanup } = makeTestDbWithMetadata();
  ensureDigestTables(db);
  seedDigestFixture(db, { dateISO: DATE, captures: 2, findings: 3, thoughts: 1, entities: 1 });
  const engine = new DigestEngine({
    db,
    getMaxItemsPerModule: () => 10,
    getSnapshot: async (id) => ({
      digestId: id,
      period: 'daily',
      range: {
        from: new Date(`${DATE}T00:00:00Z`).getTime(),
        to: new Date(`${DATE}T23:59:59.999Z`).getTime(),
      },
    }),
  });
  return { engine, db, cleanup };
}

describe('DigestEngine.generate', () => {
  let cleanup: (() => void) | null = null;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('deduplicates concurrent generate() calls by digestId', async () => {
    const t = makeEngine();
    cleanup = t.cleanup;
    const { engine } = t;
    const id = { channel: 'web', date: DATE, presetId: null };
    const spy = vi.spyOn(engine as any, 'collectModules');
    const [a, b] = await Promise.all([
      engine.generate(id, { includeAiSummary: true }),
      engine.generate(id, { includeAiSummary: true }),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(a.snapshot.generatedAt).toBe(b.snapshot.generatedAt);
  });

  it('forceRegenerate bypasses the cache and re-runs modules', async () => {
    const t = makeEngine();
    cleanup = t.cleanup;
    const { engine } = t;
    const id = { channel: 'web', date: DATE, presetId: null };
    const first = await engine.generate(id, { includeAiSummary: true });
    const second = await engine.generate(id, {
      includeAiSummary: true,
      forceRegenerate: true,
    });
    expect(second.snapshot.generatedAt).toBeGreaterThanOrEqual(first.snapshot.generatedAt);
  });

  it('reuses phase-1 snapshot when a second call only adds ai_summary', async () => {
    const t = makeEngine();
    cleanup = t.cleanup;
    const { engine } = t;
    const id = { channel: 'web', date: DATE, presetId: null };
    const noSummary = await engine.generate(id, { includeAiSummary: false });
    const spyModules = vi.spyOn(engine as any, 'collectModules');
    const withSummary = await engine.generate(id, { includeAiSummary: true });
    expect(spyModules).not.toHaveBeenCalled();
    expect(withSummary.snapshot.modules).toEqual(noSummary.snapshot.modules);
  });

  it('does not reuse phase-1 cache when snapshot info is marked volatile', async () => {
    const { db, cleanup: c2 } = makeTestDbWithMetadata();
    cleanup = c2;
    ensureDigestTables(db);
    seedDigestFixture(db, { dateISO: DATE, captures: 2 });

    let anchorMs = new Date(`${DATE}T12:00:00Z`).getTime();
    const engine = new DigestEngine({
      db,
      getMaxItemsPerModule: () => 10,
      getSnapshot: async (id) => ({
        digestId: id,
        period: 'daily' as const,
        range: {
          from: anchorMs - 24 * 3600 * 1000,
          to: anchorMs,
        },
        cacheable: false,
      }),
    });
    const spyModules = vi.spyOn(engine as any, 'collectModules');
    const id = { channel: 'web', date: DATE, presetId: 1 };

    await engine.generate(id, { includeAiSummary: false });
    anchorMs += 3600_000;
    await engine.generate(id, { includeAiSummary: false });

    expect(spyModules).toHaveBeenCalledTimes(2);
  });

  it('returns status="partial" when a module throws', async () => {
    const t = makeEngine();
    cleanup = t.cleanup;
    const { engine } = t;
    (engine as any).collectModules = async () => {
      throw new Error('boom');
    };
    const id = { channel: 'web', date: DATE, presetId: null };
    const result = await engine.generate(id, { includeAiSummary: false });
    expect(result.status).toBe('partial');
  });

  it('logs the module-collection failure via injected logger (P1-1)', async () => {
    const { db, cleanup: c2 } = makeTestDbWithMetadata();
    cleanup = c2;
    ensureDigestTables(db);
    const warn = vi.fn();
    const logger = { warn } as any;
    const engine = new (await import('../src/engine.js')).DigestEngine({
      db,
      getMaxItemsPerModule: () => 10,
      logger,
      getSnapshot: async (id) => ({
        digestId: id,
        period: 'daily' as const,
        range: {
          from: new Date(`${DATE}T00:00:00Z`).getTime(),
          to: new Date(`${DATE}T23:59:59.999Z`).getTime(),
        },
      }),
    });
    (engine as any).collectModules = async () => {
      throw new Error('module boom');
    };
    const id = { channel: 'web', date: DATE, presetId: null };
    const result = await engine.generate(id, { includeAiSummary: false });
    expect(result.status).toBe('partial');
    expect(warn).toHaveBeenCalledTimes(1);
    const [msg, payload] = warn.mock.calls[0];
    expect(String(msg)).toMatch(/collect/i);
    expect(payload).toMatchObject({ error: 'module boom' });
    expect(payload.digestId).toMatchObject({ channel: 'web', date: DATE });
  });
});
