import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDataSnapshotScheduler } from '../../src/schedulers/data-snapshot.js';
import type { DigestId, GenerateResult } from '../../src/types.js';

function fakeGenerateResult(id: DigestId): GenerateResult {
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

describe('createDataSnapshotScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires generate at the configured daily time once per day for every channel', async () => {
    const generate = vi.fn(async (id: DigestId) => fakeGenerateResult(id));
    const saveReport = vi.fn();
    // Start before the trigger, then move clock past 06:00.
    vi.setSystemTime(new Date('2026-04-19T05:59:00.000Z'));
    let currentNow = new Date('2026-04-19T06:00:00Z');
    const scheduler = createDataSnapshotScheduler({
      getDailyTimeHHMM: () => '06:00',
      getTimezone: () => 'UTC',
      generate,
      getChannels: () => ['telegram', 'web'],
      saveReport,
      nowDate: () => currentNow,
      yesterdayISO: () => '2026-04-18',
      tickIntervalMs: 1000,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1500);
    await scheduler.drain();

    expect(generate).toHaveBeenCalledTimes(2);
    const channels = generate.mock.calls.map((c) => (c[0] as DigestId).channel).sort();
    expect(channels).toEqual(['telegram', 'web']);
    expect((generate.mock.calls[0][0] as DigestId).date).toBe('2026-04-18');
    expect((generate.mock.calls[0][0] as DigestId).presetId).toBeNull();
    expect(generate.mock.calls[0][1]).toEqual({ includeAiSummary: true });

    // A fresh scheduler, same trigger minute but already fired today → no double fire.
    generate.mockClear();
    const scheduler2 = createDataSnapshotScheduler({
      getDailyTimeHHMM: () => '06:00',
      getTimezone: () => 'UTC',
      generate,
      getChannels: () => ['telegram', 'web'],
      saveReport,
      nowDate: () => currentNow,
      yesterdayISO: () => '2026-04-18',
      tickIntervalMs: 1000,
    });
    scheduler2.start();
    // Fire once then advance another tick at the same minute: second tick must be a no-op.
    await vi.advanceTimersByTimeAsync(1500);
    expect(generate).toHaveBeenCalledTimes(2);
    currentNow = new Date('2026-04-19T06:00:45Z');
    await vi.advanceTimersByTimeAsync(1500);
    expect(generate).toHaveBeenCalledTimes(2);
    await scheduler2.drain();
  });

  it('persists each generated snapshot via saveReport (P0-1)', async () => {
    const generate = vi.fn(async (id: DigestId) => fakeGenerateResult(id));
    const saveReport = vi.fn();
    vi.setSystemTime(new Date('2026-04-19T05:59:00.000Z'));
    const scheduler = createDataSnapshotScheduler({
      getDailyTimeHHMM: () => '06:00',
      getTimezone: () => 'UTC',
      generate,
      getChannels: () => ['telegram', 'web'],
      saveReport,
      nowDate: () => new Date('2026-04-19T06:00:00Z'),
      yesterdayISO: () => '2026-04-18',
      tickIntervalMs: 1000,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1500);
    await scheduler.drain();
    expect(saveReport).toHaveBeenCalledTimes(2);
    const savedChannels = saveReport.mock.calls.map((c) => c[0]).sort();
    expect(savedChannels).toEqual(['telegram', 'web']);
    expect(saveReport.mock.calls[0][1].snapshot).toBeDefined();
  });

  it('logs per-channel generate errors instead of swallowing (P1-6)', async () => {
    const generate = vi.fn(async (id: DigestId) => {
      if (id.channel === 'telegram') throw new Error('boom');
      return fakeGenerateResult(id);
    });
    const saveReport = vi.fn();
    const warn = vi.fn();
    const logger = { warn } as unknown as Parameters<
      typeof createDataSnapshotScheduler
    >[0]['logger'];
    vi.setSystemTime(new Date('2026-04-19T05:59:00.000Z'));
    const scheduler = createDataSnapshotScheduler({
      getDailyTimeHHMM: () => '06:00',
      getTimezone: () => 'UTC',
      generate,
      getChannels: () => ['telegram', 'web'],
      saveReport,
      logger,
      nowDate: () => new Date('2026-04-19T06:00:00Z'),
      yesterdayISO: () => '2026-04-18',
      tickIntervalMs: 1000,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1500);
    await scheduler.drain();
    // Both channels attempted; only `web` saves.
    expect(saveReport).toHaveBeenCalledTimes(1);
    expect(saveReport.mock.calls[0][0]).toBe('web');
    // The telegram failure is logged (no longer silent).
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ channelId: 'telegram', error: 'boom' });
  });

  it('drain() awaits inflight generate and stops further ticks', async () => {
    let resolveGenerate: (() => void) | undefined;
    const generate = vi.fn(
      (id: DigestId) =>
        new Promise<GenerateResult>((res) => {
          resolveGenerate = () => res(fakeGenerateResult(id));
        }),
    );
    const saveReport = vi.fn();
    vi.setSystemTime(new Date('2026-04-19T05:59:00.000Z'));
    const scheduler = createDataSnapshotScheduler({
      getDailyTimeHHMM: () => '06:00',
      getTimezone: () => 'UTC',
      generate,
      getChannels: () => ['web'],
      saveReport,
      nowDate: () => new Date('2026-04-19T06:00:00Z'),
      yesterdayISO: () => '2026-04-18',
      tickIntervalMs: 1,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(5);
    expect(generate).toHaveBeenCalledTimes(1);

    let drainResolved = false;
    const drainP = scheduler.drain().then(() => {
      drainResolved = true;
    });
    await Promise.resolve();
    expect(drainResolved).toBe(false);

    resolveGenerate?.();
    await drainP;

    // After drain, further ticks do not fire.
    generate.mockClear();
    await vi.advanceTimersByTimeAsync(100);
    expect(generate).not.toHaveBeenCalled();
  });

  describe('timezone-aware triggering', () => {
    it('fires dailyTime "09:00" in Asia/Shanghai at UTC 01:00', async () => {
      const generate = vi.fn(async (id: DigestId) => fakeGenerateResult(id));
      const saveReport = vi.fn();
      // UTC 01:00 = Asia/Shanghai 09:00 (CST, UTC+8, no DST).
      vi.setSystemTime(new Date('2026-05-14T00:59:00.000Z'));
      const fakeNow = new Date('2026-05-14T01:00:00Z');
      const scheduler = createDataSnapshotScheduler({
        getDailyTimeHHMM: () => '09:00',
        getTimezone: () => 'Asia/Shanghai',
        generate,
        getChannels: () => ['default'],
        saveReport,
        nowDate: () => fakeNow,
        yesterdayISO: () => '2026-05-13',
        tickIntervalMs: 1000,
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(1500);
      await scheduler.drain();
      expect(generate).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'default', date: '2026-05-13' }),
        expect.objectContaining({ includeAiSummary: true }),
      );
    });

    it('does NOT fire when UTC 09:00 differs from local 09:00 in Asia/Shanghai', async () => {
      const generate = vi.fn(async (id: DigestId) => fakeGenerateResult(id));
      const saveReport = vi.fn();
      // UTC 09:00 = Asia/Shanghai 17:00 (not 09:00) → must not trigger.
      vi.setSystemTime(new Date('2026-05-14T08:59:00.000Z'));
      const fakeNow = new Date('2026-05-14T09:00:00Z');
      const scheduler = createDataSnapshotScheduler({
        getDailyTimeHHMM: () => '09:00',
        getTimezone: () => 'Asia/Shanghai',
        generate,
        getChannels: () => ['default'],
        saveReport,
        nowDate: () => fakeNow,
        yesterdayISO: () => '2026-05-13',
        tickIntervalMs: 1000,
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(1500);
      await scheduler.drain();
      expect(generate).not.toHaveBeenCalled();
    });
  });
});
