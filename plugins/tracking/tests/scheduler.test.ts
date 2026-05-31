import { getRawDatabase } from '@goldpan/core/db';
import { NOW_MS_SQL } from '@goldpan/core/db/sql-fragments';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDB } from '../../../packages/core/tests/helpers/test-db';
import { ensureTrackingTables } from '../src/db';

vi.mock('../src/executor.js', () => ({
  executeInterest: vi.fn(),
}));

import { executeInterest } from '../src/executor';
import { createScheduler, type SchedulerDeps } from '../src/scheduler';

const mockExecuteInterest = vi.mocked(executeInterest);

function insertInterest(
  rawDb: any,
  overrides: {
    enabled?: number;
    status?: string;
    next_run_at?: string;
    interval_minutes?: number;
    name?: string;
    search_queries_json?: string;
  } = {},
): number {
  const enabled = overrides.enabled ?? 1;
  const status = overrides.status ?? 'idle';
  const nextRunAt = overrides.next_run_at ?? `(${NOW_MS_SQL} - 60000)`;
  const interval = overrides.interval_minutes ?? 60;
  const name = overrides.name ?? 'Interest';
  const searchQueriesJson = overrides.search_queries_json ?? '["test"]';

  const res = rawDb
    .prepare(
      `INSERT INTO tracking_rules (name, search_queries_json, tool_provider, interval_minutes, enabled, status, next_run_at)
       VALUES (?, ?, null, ?, ?, ?, ${nextRunAt})`,
    )
    .run(name, searchQueriesJson, interval, enabled, status);
  return Number(res.lastInsertRowid);
}

function getInterestStatus(
  rawDb: any,
  interestId: number,
): { status: string; next_run_at: string | null; last_run_at: string | null } {
  return rawDb
    .prepare('SELECT status, next_run_at, last_run_at FROM tracking_rules WHERE id = ?')
    .get(interestId) as any;
}

function getExecutions(rawDb: any, interestId: number) {
  return rawDb
    .prepare('SELECT * FROM tracking_executions WHERE rule_id = ? ORDER BY id')
    .all(interestId) as Array<{
    id: number;
    rule_id: number;
    status: string;
    items_found: number;
    items_submitted: number;
    error_message: string | null;
  }>;
}

function getLogs(rawDb: any, interestId: number) {
  return rawDb
    .prepare('SELECT * FROM tracking_logs WHERE rule_id = ? ORDER BY id')
    .all(interestId) as Array<{
    id: number;
    rule_id: number;
    execution_id: number | null;
    level: string;
    message: string;
  }>;
}

describe('createScheduler', () => {
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

  function makeDeps(
    overrides: Partial<SchedulerDeps> & {
      pollIntervalMs?: number;
      dailySearchLimit?: number;
      maxResultsPerSearch?: number;
    } = {},
  ): SchedulerDeps {
    // Existing tests express runtime config as flat top-level overrides; fold
    // them into the new `getRuntimeConfig` getter shape so we don't have to
    // rewrite every call site. `getRuntimeConfig` (when supplied) takes
    // precedence — used by the hot-reload test that mutates these per-tick.
    const pollIntervalMs = overrides.pollIntervalMs ?? 1000;
    const dailySearchLimit = overrides.dailySearchLimit ?? 100;
    const maxResultsPerSearch = overrides.maxResultsPerSearch ?? 10;
    return {
      db,
      pluginRegistry: mockPluginRegistry,
      submitInput: mockSubmitInput,
      getRuntimeConfig:
        overrides.getRuntimeConfig ??
        (() => ({
          pollIntervalMs,
          dailySearchLimit,
          maxResultsPerSearch,
        })),
    };
  }

  it('claims due interests (status idle, enabled, next_run_at <= now)', async () => {
    const interestId = insertInterest(rawDb);
    mockExecuteInterest.mockResolvedValue({
      itemsFound: 2,
      itemsSubmitted: 1,
      status: 'done',
    });

    const scheduler = createScheduler(makeDeps());
    scheduler.startScheduler();

    // Advance to trigger tick
    await vi.advanceTimersByTimeAsync(1100);

    expect(mockExecuteInterest).toHaveBeenCalledTimes(1);
    expect(mockExecuteInterest).toHaveBeenCalledWith(
      expect.objectContaining({ id: interestId }),
      expect.any(Number),
      expect.any(Object),
      expect.any(AbortSignal),
    );

    // Execution row should be created
    const execs = getExecutions(rawDb, interestId);
    expect(execs).toHaveLength(1);
    expect(execs[0].status).toBe('done');
    expect(execs[0].items_found).toBe(2);
    expect(execs[0].items_submitted).toBe(1);

    await scheduler.drainScheduler();
  });

  it('passes parsed searchQueries array to executor', async () => {
    const interestId = insertInterest(rawDb, {
      search_queries_json: '["alpha","beta","gamma"]',
    });
    mockExecuteInterest.mockResolvedValue({
      itemsFound: 0,
      itemsSubmitted: 0,
      status: 'done',
    });

    const scheduler = createScheduler(makeDeps());
    scheduler.startScheduler();

    await vi.advanceTimersByTimeAsync(1100);

    expect(mockExecuteInterest).toHaveBeenCalledWith(
      expect.objectContaining({
        id: interestId,
        searchQueries: ['alpha', 'beta', 'gamma'],
        toolProvider: null,
      }),
      expect.any(Number),
      expect.any(Object),
      expect.any(AbortSignal),
    );

    await scheduler.drainScheduler();
  });

  it('skips disabled interests', async () => {
    insertInterest(rawDb, { enabled: 0 });
    mockExecuteInterest.mockResolvedValue({ itemsFound: 0, itemsSubmitted: 0, status: 'done' });

    const scheduler = createScheduler(makeDeps());
    scheduler.startScheduler();

    await vi.advanceTimersByTimeAsync(1100);

    expect(mockExecuteInterest).not.toHaveBeenCalled();

    await scheduler.drainScheduler();
  });

  it('skips interests with status=executing', async () => {
    insertInterest(rawDb, { status: 'executing' });
    mockExecuteInterest.mockResolvedValue({ itemsFound: 0, itemsSubmitted: 0, status: 'done' });

    const scheduler = createScheduler(makeDeps());
    scheduler.startScheduler();

    await vi.advanceTimersByTimeAsync(1100);

    expect(mockExecuteInterest).not.toHaveBeenCalled();

    await scheduler.drainScheduler();
  });

  it('respects daily search limit', async () => {
    insertInterest(rawDb, { name: 'R1' });
    insertInterest(rawDb, { name: 'R2' });

    mockExecuteInterest.mockResolvedValue({ itemsFound: 1, itemsSubmitted: 1, status: 'done' });

    const scheduler = createScheduler(makeDeps({ dailySearchLimit: 1 }));
    scheduler.startScheduler();

    await vi.advanceTimersByTimeAsync(1100);

    // Only 1 should execute due to daily limit of 1
    expect(mockExecuteInterest).toHaveBeenCalledTimes(1);

    await scheduler.drainScheduler();
  });

  it('mid-batch limit exhaustion: claim 3 interests, limit allows 1 → #1 executes, #2+3 reset to idle', async () => {
    const _r1 = insertInterest(rawDb, { name: 'R1' });
    const r2 = insertInterest(rawDb, { name: 'R2' });
    const r3 = insertInterest(rawDb, { name: 'R3' });

    mockExecuteInterest.mockResolvedValue({ itemsFound: 1, itemsSubmitted: 1, status: 'done' });

    const scheduler = createScheduler(makeDeps({ dailySearchLimit: 1 }));
    scheduler.startScheduler();

    await vi.advanceTimersByTimeAsync(1100);

    // Only first interest executes
    expect(mockExecuteInterest).toHaveBeenCalledTimes(1);

    // Interests #2 and #3 should be reset to idle
    const r2Status = getInterestStatus(rawDb, r2);
    const r3Status = getInterestStatus(rawDb, r3);
    expect(r2Status.status).toBe('idle');
    expect(r3Status.status).toBe('idle');

    // Warning logs should be written for skipped interests
    const logs2 = getLogs(rawDb, r2);
    const logs3 = getLogs(rawDb, r3);
    expect(logs2.some((l) => l.level === 'warn' && l.message.includes('Daily search limit'))).toBe(
      true,
    );
    expect(logs3.some((l) => l.level === 'warn' && l.message.includes('Daily search limit'))).toBe(
      true,
    );

    await scheduler.drainScheduler();
  });

  it('resets interest status to idle after execution', async () => {
    const interestId = insertInterest(rawDb);
    mockExecuteInterest.mockResolvedValue({ itemsFound: 0, itemsSubmitted: 0, status: 'done' });

    const scheduler = createScheduler(makeDeps());
    scheduler.startScheduler();

    await vi.advanceTimersByTimeAsync(1100);

    const interestState = getInterestStatus(rawDb, interestId);
    expect(interestState.status).toBe('idle');

    await scheduler.drainScheduler();
  });

  it('advances next_run_at after execution', async () => {
    const interestId = insertInterest(rawDb, { interval_minutes: 120 });
    mockExecuteInterest.mockResolvedValue({ itemsFound: 0, itemsSubmitted: 0, status: 'done' });

    const scheduler = createScheduler(makeDeps());
    scheduler.startScheduler();

    await vi.advanceTimersByTimeAsync(1100);

    const interestState = getInterestStatus(rawDb, interestId);
    expect(interestState.last_run_at).not.toBeNull();
    expect(interestState.next_run_at).not.toBeNull();

    // next_run_at should be in the future (approximately 120 minutes from now)
    const nextRunMs = interestState.next_run_at as unknown as number;
    // Allow some tolerance — next_run_at should be at least 100 min from now
    expect(nextRunMs - Date.now()).toBeGreaterThan(100 * 60 * 1000);

    await scheduler.drainScheduler();
  });

  it('drain: stops polling, awaits in-flight execution', async () => {
    const _interestId = insertInterest(rawDb);

    let resolveExec: () => void;
    const execPromise = new Promise<void>((r) => {
      resolveExec = r;
    });

    mockExecuteInterest.mockImplementation(async () => {
      await execPromise;
      return { itemsFound: 1, itemsSubmitted: 0, status: 'done' as const };
    });

    const scheduler = createScheduler(makeDeps());
    scheduler.startScheduler();

    // Advance to trigger tick
    await vi.advanceTimersByTimeAsync(1100);

    // Start drain (should await in-flight)
    const drainPromise = scheduler.drainScheduler();

    // Resolve the execution
    resolveExec!();
    await drainPromise;

    // After drain, globalThis flag should be cleared
    expect((globalThis as any).__goldpan_tracking_scheduler_started).toBeUndefined();

    // No more ticks should happen
    mockExecuteInterest.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockExecuteInterest).not.toHaveBeenCalled();
  });

  it('idempotent start (second call no-ops)', async () => {
    mockExecuteInterest.mockResolvedValue({ itemsFound: 0, itemsSubmitted: 0, status: 'done' });

    const scheduler = createScheduler(makeDeps());
    scheduler.startScheduler();
    scheduler.startScheduler(); // second call should no-op

    // The global flag should be set
    expect((globalThis as any).__goldpan_tracking_scheduler_started).toBe(true);

    await scheduler.drainScheduler();
  });
});
