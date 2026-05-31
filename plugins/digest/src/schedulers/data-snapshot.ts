import { errorMessage } from '@goldpan/core/errors';
import { localHourMinute, localYMD } from '@goldpan/core/lib/tz';
import type { ILogObj, Logger } from 'tslog';
import { yesterdayLocalISO } from '../render/helpers.js';
import type { DigestId, GenerateResult } from '../types.js';

export interface SchedulerDeps {
  /**
   * Trigger time-of-day in HH:MM (24h), interpreted in the configured tz.
   * Getter (NOT a captured string) so a runtime commit of
   * `GOLDPAN_DIGEST_DAILY_TIME` takes effect on the next tick without
   * restart. The plugin wires this to
   * `() => configStore.getSnapshot().config.digest.dailyTime`.
   *
   * The poll-based design (one tick every `tickIntervalMs`) means a dailyTime
   * change is automatically picked up at the next tick — no `onChange`
   * subscription is needed (unlike a `setTimeout`-until-next-fire architecture
   * where a stale captured value would freeze the schedule until the next
   * fire). Worst-case latency is `tickIntervalMs` (default 60s) which matches
   * the scheduler's existing time resolution.
   */
  getDailyTimeHHMM: () => string;
  /**
   * Effective IANA timezone for trigger comparison + "yesterday" date
   * computation. Getter mirrors `getDailyTimeHHMM` so a runtime commit of
   * `GOLDPAN_TIMEZONE` picks up at the next tick (worst-case latency =
   * `tickIntervalMs`) — no scheduler restart, no `onChange` wiring needed.
   * The plugin wires this to
   * `() => configStore.getSnapshot().config.timezone`.
   */
  getTimezone: () => string;
  generate: (id: DigestId, opts: { includeAiSummary: true }) => Promise<GenerateResult>;
  getChannels: () => string[];
  /**
   * Persist every generated snapshot. Required: without it, `daily_reports`
   * was never populated for the daily cron path (P0-1). Implementations
   * typically forward to `DigestCrudService.saveReport`.
   */
  saveReport: (channelId: string, result: GenerateResult) => void | Promise<void>;
  /** Optional logger for per-channel failure diagnostics (P1-6). */
  logger?: Logger<ILogObj>;
  /** Override for tests; defaults to `() => new Date()`. */
  nowDate?: () => Date;
  /** Override for tests; defaults to yesterday's date in the configured tz. */
  yesterdayISO?: () => string;
  /** How often to poll for the trigger minute. Defaults to 60_000ms (1 min). */
  tickIntervalMs?: number;
}

export interface SchedulerHandle {
  start(): void;
  drain(): Promise<void>;
}

/**
 * Poll-based daily scheduler. Checks every `tickIntervalMs` whether the
 * current time in the configured tz matches `getDailyTimeHHMM()`; when it
 * does, calls `generate(...)` once per channel for yesterday's date (also
 * computed in the configured tz) with `includeAiSummary: true`, then
 * persists the result via `saveReport`. Deduped per local day via
 * `lastFiredDate`.
 *
 * `drain()` clears the timer and awaits any in-flight generate calls so
 * the scheduler's work is quiesced before a graceful shutdown proceeds.
 */
export function createDataSnapshotScheduler(deps: SchedulerDeps): SchedulerHandle {
  const tickMs = deps.tickIntervalMs ?? 60_000;
  const now = deps.nowDate ?? (() => new Date());

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let lastFiredDate: string | null = null;
  const inflight = new Set<Promise<unknown>>();

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(tick, tickMs);
    const t = timer as { unref?: () => void };
    t.unref?.();
  }

  function tick(): void {
    timer = null;
    if (stopped) return;
    const d = now();
    // Read tz + dailyTime fresh on every tick so runtime config commits to
    // GOLDPAN_TIMEZONE / GOLDPAN_DIGEST_DAILY_TIME hot-reload without
    // restart. The cost is two integer parses + an Intl call per minute,
    // far cheaper than re-instantiating the scheduler on commit.
    const tz = deps.getTimezone();
    const todayISO = localYMD(d, tz);
    const [hhStr, mmStr] = deps.getDailyTimeHHMM().split(':');
    const targetHh = Number(hhStr);
    const targetMm = Number(mmStr);
    const { hh: localHh, mm: localMm } = localHourMinute(d, tz);
    if (localHh === targetHh && localMm === targetMm && lastFiredDate !== todayISO) {
      lastFiredDate = todayISO;
      const date = deps.yesterdayISO?.() ?? yesterdayLocalISO(d, tz);
      for (const channel of deps.getChannels()) {
        const p = (async () => {
          try {
            const result = await deps.generate(
              { channel, date, presetId: null },
              { includeAiSummary: true },
            );
            await deps.saveReport(channel, result);
          } catch (err) {
            deps.logger?.warn('digest data-snapshot scheduler failed for channel', {
              channelId: channel,
              date,
              error: errorMessage(err),
              stack: err instanceof Error ? err.stack : undefined,
            });
          }
        })();
        inflight.add(p);
        p.finally(() => inflight.delete(p));
      }
    }
    schedule();
  }

  return {
    start(): void {
      schedule();
    },
    async drain(): Promise<void> {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await Promise.allSettled([...inflight]);
    },
  };
}
