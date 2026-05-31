import { describe, expect, it, vi } from 'vitest';
import { ensureDigestTables } from '../../src/db.js';
import { DigestEngine } from '../../src/engine.js';
import { createDataSnapshotScheduler } from '../../src/schedulers/data-snapshot.js';
import type { DigestId, GenerateResult } from '../../src/types.js';
import { makeTestDbWithMetadata, seedDigestFixture } from '../fixtures/seed.js';

function fakeResult(id: DigestId): GenerateResult {
  return {
    status: 'complete',
    snapshot: {
      digestId: id,
      period: 'daily',
      generatedAt: 0,
      modules: {
        tracking_findings: { type: 'tracking_findings', items: [], hasMore: false, hiddenCount: 0 },
        captures: { type: 'captures', items: [], hasMore: false, hiddenCount: 0 },
        thoughts: { type: 'thoughts', items: [], hasMore: false, hiddenCount: 0 },
        new_entities: { type: 'new_entities', items: [], hasMore: false, hiddenCount: 0 },
        stats: { type: 'stats', captures: 0, findings: 0, thoughts: 0, entities: 0 },
      },
      aiSummary: { status: 'fallback', text: '' },
    },
  };
}

describe('digest scheduler — config hot reload', () => {
  it('next tick reads new dailyTime after config change (no scheduler restart)', async () => {
    vi.useFakeTimers();
    try {
      // Mutable getter — proxies what configStore.getSnapshot().config.digest.dailyTime
      // would return. Bumping the local variable simulates a runtime commit.
      let dailyTime = '06:00';
      const generate = vi.fn(async (id: DigestId) => fakeResult(id));
      const saveReport = vi.fn();
      // Drive `now()` explicitly so the test is independent of wall-clock.
      let currentNow = new Date('2026-04-19T05:59:30.000Z');

      const scheduler = createDataSnapshotScheduler({
        getDailyTimeHHMM: () => dailyTime,
        getTimezone: () => 'UTC',
        generate,
        getChannels: () => ['web'],
        saveReport,
        nowDate: () => currentNow,
        yesterdayISO: () => '2026-04-18',
        tickIntervalMs: 1000,
      });
      scheduler.start();

      // Tick at 05:59:30 → no fire (not the configured minute).
      currentNow = new Date('2026-04-19T05:59:30Z');
      await vi.advanceTimersByTimeAsync(1100);
      expect(generate).toHaveBeenCalledTimes(0);

      // Bump dailyTime to 05:59 BEFORE the next tick. The tick must read the
      // new value — without the getter pattern, the original 06:00 was
      // captured at construction and would never fire at 05:59.
      dailyTime = '05:59';
      // Hold time inside 05:59. Even if the previous test setup did not
      // record a fire-at-this-minute, the new value should drive the fire.
      currentNow = new Date('2026-04-19T05:59:35Z');
      await vi.advanceTimersByTimeAsync(1100);

      expect(generate).toHaveBeenCalledTimes(1);
      const firedId = generate.mock.calls[0][0] as DigestId;
      expect(firedId.channel).toBe('web');
      expect(firedId.date).toBe('2026-04-18');

      await scheduler.drain();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT fire at the OLD time after dailyTime is changed (stale capture would re-fire)', async () => {
    vi.useFakeTimers();
    try {
      let dailyTime = '06:00';
      const generate = vi.fn(async (id: DigestId) => fakeResult(id));
      const saveReport = vi.fn();
      let currentNow = new Date('2026-04-19T05:59:30Z');

      const scheduler = createDataSnapshotScheduler({
        getDailyTimeHHMM: () => dailyTime,
        getTimezone: () => 'UTC',
        generate,
        getChannels: () => ['web'],
        saveReport,
        nowDate: () => currentNow,
        yesterdayISO: () => '2026-04-18',
        tickIntervalMs: 1000,
      });
      scheduler.start();

      // Move dailyTime away from 06:00 BEFORE the 06:00 mark.
      dailyTime = '21:00';
      currentNow = new Date('2026-04-19T06:00:30Z');
      await vi.advanceTimersByTimeAsync(1100);

      // 06:00 is the OLD time — must NOT fire because tick re-read getter
      // and saw 21:00.
      expect(generate).toHaveBeenCalledTimes(0);

      await scheduler.drain();
    } finally {
      vi.useRealTimers();
    }
  });

  it('engine reads maxItemsPerModule fresh on each generate (hot reload)', async () => {
    const { db, cleanup } = makeTestDbWithMetadata();
    try {
      ensureDigestTables(db);
      // Seed plenty of items so the cap is observable.
      const date = '2026-04-18';
      seedDigestFixture(db, { dateISO: date, captures: 5 });

      let maxItems = 2;
      const engine = new DigestEngine({
        db,
        getMaxItemsPerModule: () => maxItems,
        getSnapshot: async (id) => ({
          digestId: id,
          period: 'daily' as const,
          range: {
            from: new Date(`${date}T00:00:00Z`).getTime(),
            to: new Date(`${date}T23:59:59.999Z`).getTime(),
          },
        }),
      });

      const id1 = { channel: 'web', date, presetId: null };
      // First generate with maxItems = 2 → capped at 2.
      const first = await engine.generate(id1, {
        includeAiSummary: false,
        forceRegenerate: true,
      });
      expect(first.snapshot.modules.captures.type).toBe('captures');
      if (first.snapshot.modules.captures.type === 'captures') {
        expect(first.snapshot.modules.captures.items.length).toBe(2);
      }

      // Mutate the underlying value — simulates a runtime commit of
      // GOLDPAN_DIGEST_MAX_ITEMS_PER_MODULE — and regenerate.
      maxItems = 4;
      const second = await engine.generate(id1, {
        includeAiSummary: false,
        forceRegenerate: true,
      });
      if (second.snapshot.modules.captures.type === 'captures') {
        expect(second.snapshot.modules.captures.items.length).toBe(4);
      }
    } finally {
      cleanup();
    }
  });

  it('engine cached path also honors a new maxItemsPerModule (review H-2 regression)', async () => {
    // Without `maxItems` in the cache key, this exact sequence broke: the
    // first generate cached modules at cap=2; the second generate (NOT
    // forceRegenerate) returned the cached modules verbatim, ignoring the
    // user's runtime commit to cap=4. The fix wires `maxItems` into the
    // cache key so a config change naturally misses the cache and re-runs
    // collectModules with the latest value.
    const { db, cleanup } = makeTestDbWithMetadata();
    try {
      ensureDigestTables(db);
      const date = '2026-04-18';
      seedDigestFixture(db, { dateISO: date, captures: 5 });

      let maxItems = 2;
      const engine = new DigestEngine({
        db,
        getMaxItemsPerModule: () => maxItems,
        getSnapshot: async (id) => ({
          digestId: id,
          period: 'daily' as const,
          range: {
            from: new Date(`${date}T00:00:00Z`).getTime(),
            to: new Date(`${date}T23:59:59.999Z`).getTime(),
          },
        }),
      });
      const id1 = { channel: 'web', date, presetId: null };

      // First call (no force): collects modules under cap=2 and caches them.
      const first = await engine.generate(id1, { includeAiSummary: false });
      if (first.snapshot.modules.captures.type === 'captures') {
        expect(first.snapshot.modules.captures.items.length).toBe(2);
      }

      // Bump the cap, then call again WITHOUT forceRegenerate. The previous
      // implementation hit the cache and returned cap-2 modules, masking the
      // hot-reload contract for `/digest` and preview paths. Now the cache
      // key includes maxItems so this is a cache miss → fresh collection
      // under the new cap.
      maxItems = 4;
      const second = await engine.generate(id1, { includeAiSummary: false });
      if (second.snapshot.modules.captures.type === 'captures') {
        expect(second.snapshot.modules.captures.items.length).toBe(4);
      }

      // Sanity: another call at the new cap reuses the new cache entry
      // rather than re-running collectModules each time.
      const third = await engine.generate(id1, { includeAiSummary: false });
      if (third.snapshot.modules.captures.type === 'captures') {
        expect(third.snapshot.modules.captures.items.length).toBe(4);
      }
    } finally {
      cleanup();
    }
  });
});
