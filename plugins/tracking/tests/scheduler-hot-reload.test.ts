import { getRawDatabase } from '@goldpan/core/db';
import { NOW_MS_SQL } from '@goldpan/core/db/sql-fragments';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDB } from '../../../packages/core/tests/helpers/test-db';
import { ensureTrackingTables } from '../src/db';

// Mock executor.js BEFORE importing scheduler so the import sees the mock.
vi.mock('../src/executor.js', () => ({
  executeInterest: vi.fn(),
}));

import { executeInterest } from '../src/executor';
import { createScheduler, type SchedulerRuntimeConfig } from '../src/scheduler';

const mockExecuteInterest = vi.mocked(executeInterest);

/**
 * Hot-reload regression test. Before this PR `pollIntervalMs` /
 * `dailySearchLimit` / `maxResultsPerSearch` were closure-captured at
 * `createScheduler()` time, so a runtime-config commit (e.g. via
 * `configStore.commit({ GOLDPAN_TRACKING_POLL_INTERVAL: ... })`) had no
 * effect until restart. After the refactor the scheduler resolves these
 * values via `deps.getRuntimeConfig()` on every reschedule / decision, so
 * mutating the getter's return value here should affect the *next* tick
 * without re-creating the scheduler.
 *
 * The test deliberately uses a hand-rolled getter (a mutable holder) instead
 * of plumbing a real `ConfigStore` — the closure-pinning bug lives in the
 * scheduler factory, so a focused unit test is the right scope. End-to-end
 * `commit() → process.env → next tick` is covered indirectly by
 * `index.ts:initialize` wiring a `process.env`-reading getter, and by the
 * existing `tests/config/store.test.ts` which proves `commit` writes
 * `process.env` for managed keys.
 */
describe('tracking scheduler — config hot reload', () => {
  let db: any;
  let rawDb: any;
  let cleanup: () => void;

  const mockSubmitInput = vi.fn();
  const mockPluginRegistry = {} as any;

  beforeEach(() => {
    vi.useFakeTimers();
    const testDb = createTestDB();
    db = testDb.db;
    rawDb = getRawDatabase(db);
    cleanup = testDb.cleanup;
    ensureTrackingTables(db);

    mockExecuteInterest.mockReset();
    mockSubmitInput.mockReset();
    delete (globalThis as any).__goldpan_tracking_scheduler_started;
  });

  afterEach(() => {
    delete (globalThis as any).__goldpan_tracking_scheduler_started;
    vi.useRealTimers();
    cleanup();
  });

  function insertInterest(name = 'r1'): number {
    const res = rawDb
      .prepare(
        `INSERT INTO tracking_rules (name, search_queries_json, tool_provider, interval_minutes, enabled, status, next_run_at)
         VALUES (?, '["q"]', null, 60, 1, 'idle', (${NOW_MS_SQL} - 60000))`,
      )
      .run(name);
    return Number(res.lastInsertRowid);
  }

  it('next reschedule observes a mutated pollIntervalMs (closure-pinning regression)', async () => {
    insertInterest('hot-reload-r1');
    mockExecuteInterest.mockResolvedValue({
      itemsFound: 0,
      itemsSubmitted: 0,
      status: 'done',
    });

    // Mutable holder — the closure-pinning bug, if it returned, would mean
    // the scheduler ignores writes to `runtime.pollIntervalMs` after construction.
    const runtime: SchedulerRuntimeConfig = {
      pollIntervalMs: 1000,
      dailySearchLimit: 100,
      maxResultsPerSearch: 10,
    };

    // Track every observed pollIntervalMs the scheduler reads via the getter.
    // This tells us which value drove each `setTimeout(scheduleTick, delay)`
    // call without having to pierce the fake-timer internals.
    const observedPollIntervals: number[] = [];
    const getRuntimeConfig = () => {
      observedPollIntervals.push(runtime.pollIntervalMs);
      return runtime;
    };

    const scheduler = createScheduler({
      db,
      pluginRegistry: mockPluginRegistry,
      submitInput: mockSubmitInput,
      getRuntimeConfig,
    });

    scheduler.startScheduler();

    // After startScheduler, scheduleTick has run once and invoked the getter
    // once for the first setTimeout delay.
    expect(observedPollIntervals).toEqual([1000]);

    // Mutate BEFORE the next scheduleTick reads the getter. With the old
    // closure-pinned scheduler the next reschedule would still use 1000 —
    // the assertion at the bottom would catch it.
    runtime.pollIntervalMs = 500;

    // Run the first tick to completion. The tick body re-reads the getter
    // (for dailySearchLimit / maxResultsPerSearch), then `.finally` invokes
    // scheduleTick again which reads it once more for the next delay.
    await vi.advanceTimersByTimeAsync(1100);
    expect(mockExecuteInterest).toHaveBeenCalledTimes(1);

    // Drain microtasks so the `.finally(() => scheduleTick())` callback runs.
    await vi.advanceTimersByTimeAsync(0);

    // The MOST RECENT call (the one driving the second setTimeout delay)
    // saw the mutated 500 — that's the hot-reload contract.
    expect(observedPollIntervals[observedPollIntervals.length - 1]).toBe(500);

    await scheduler.drainScheduler();
  });

  it('next tick passes a mutated maxResultsPerSearch to executeInterest', async () => {
    // Regression for PR2 review C-3: MAX_RESULTS_PER_SEARCH must hot-reload
    // alongside POLL / DAILY_LIMIT. The tick body re-reads the runtime config
    // once at entry, then plumbs `maxResultsPerSearch` into executeInterest's
    // capabilities — mutating the holder before the timer fires must surface
    // the new value to the executor, not the boot value.
    insertInterest('max-results-r1');
    mockExecuteInterest.mockResolvedValue({
      itemsFound: 0,
      itemsSubmitted: 0,
      status: 'done',
    });

    const runtime: SchedulerRuntimeConfig = {
      pollIntervalMs: 1000,
      dailySearchLimit: 100,
      maxResultsPerSearch: 10,
    };

    const scheduler = createScheduler({
      db,
      pluginRegistry: mockPluginRegistry,
      submitInput: mockSubmitInput,
      getRuntimeConfig: () => runtime,
    });

    scheduler.startScheduler();

    // Mutate before the timer fires. Closure-pinned scheduler would have
    // captured 10 at construction → executor would still see 10.
    runtime.maxResultsPerSearch = 3;

    await vi.advanceTimersByTimeAsync(1100);

    expect(mockExecuteInterest).toHaveBeenCalledTimes(1);
    // executeInterest(input, executionId, capabilities, signal) — the third
    // arg carries `maxResultsPerSearch`, which must reflect the post-mutation
    // value 3.
    const capabilities = mockExecuteInterest.mock.calls[0]?.[2];
    expect(capabilities?.maxResultsPerSearch).toBe(3);

    await scheduler.drainScheduler();
  });

  it('mid-flight tick honors a mutated dailySearchLimit on the same batch', async () => {
    // Two due rules — the runtime starts with dailySearchLimit=100 (both will
    // execute) but we drop it to 1 BEFORE the tick fires. The tick re-reads
    // `getRuntimeConfig()` once at entry, so it sees the new limit and only
    // executes the first rule.
    insertInterest('limit-r1');
    insertInterest('limit-r2');

    mockExecuteInterest.mockResolvedValue({
      itemsFound: 0,
      itemsSubmitted: 0,
      status: 'done',
    });

    const runtime: SchedulerRuntimeConfig = {
      pollIntervalMs: 1000,
      dailySearchLimit: 100,
      maxResultsPerSearch: 10,
    };

    const scheduler = createScheduler({
      db,
      pluginRegistry: mockPluginRegistry,
      submitInput: mockSubmitInput,
      getRuntimeConfig: () => runtime,
    });

    scheduler.startScheduler();

    // Mutate before the timer fires. With the old closure-pinned
    // scheduler, the in-tick `dailySearchCount >= deps.dailySearchLimit`
    // check would still be against 100 → both rules execute.
    runtime.dailySearchLimit = 1;

    await vi.advanceTimersByTimeAsync(1100);

    // After the tick, only the first rule was executed; the second got
    // skipped due to the new limit.
    expect(mockExecuteInterest).toHaveBeenCalledTimes(1);

    await scheduler.drainScheduler();
  });
});
