import { mintShareUrl } from '@goldpan/core/digest-link/sign';
import { errorMessage } from '@goldpan/core/errors';
import { epochMsForLocal, localWeekday, localYMD } from '@goldpan/core/lib/tz';
import type { IntentPluginResult } from '@goldpan/core/plugins';
import type { ILogObj, Logger } from 'tslog';
import { IM_SHARE_FOOTER, yesterdayLocalISO } from '../render/helpers.js';
import type { DigestId, DigestPresetRow, DigestSubscriptionRow, GenerateResult } from '../types.js';

export interface PushDeps {
  /** Return every subscription that could be due for a push (paused rows are filtered inside runOnce). */
  listDueSubscriptions: () => DigestSubscriptionRow[];
  getPreset: (id: number) => DigestPresetRow | null;
  generate: (id: DigestId, preset: DigestPresetRow) => Promise<GenerateResult>;
  isFullyEmpty: (result: GenerateResult) => boolean;
  renderIM: (result: GenerateResult, preset: DigestPresetRow, language: 'en' | 'zh') => string;
  sendOutbound: (
    channelId: string,
    ref: DigestSubscriptionRow,
    result: IntentPluginResult,
  ) => Promise<void>;
  markPushed: (subscriptionId: number, at: number) => void;
  /**
   * Persist every generated snapshot (both pushed and skipEmpty-skipped).
   * Required: without it, `daily_reports` is never populated for the IM
   * push path. Implementations typically forward to
   * `DigestCrudService.saveReport`.
   */
  saveReport: (channelId: string, result: GenerateResult) => void | Promise<void>;
  /**
   * Effective IANA timezone for the per-subscription push-time boundary,
   * weekly weekday comparison, and "yesterday" content-date dedupe. Getter
   * (NOT a captured string) so a runtime commit of `GOLDPAN_TIMEZONE` is
   * picked up on the next tick (worst-case latency = `tickIntervalMs`) —
   * no scheduler restart, no `onChange` wiring needed. The plugin wires
   * this to `() => configStore.getSnapshot().config.timezone`, mirroring
   * `data-snapshot.ts`'s `getTimezone` shape.
   */
  getTimezone: () => string;
  /** Optional logger for per-tick failure diagnostics. */
  logger?: Logger<ILogObj>;
  /** Override for tests; defaults to `() => new Date()`. */
  now?: () => Date;
  /** Tick interval for `start()`; defaults to 60_000ms. */
  tickIntervalMs?: number;
  /** Per-channel language selector; defaults to `'en'` for every channel. */
  channelLanguage?: (channelId: string) => 'en' | 'zh';
  /** Whether the target outbound channel is currently able to deliver. */
  canSendChannel?: (channelId: string) => boolean;
  /** Lookup daily_reports.id by composite key. Returns null if row missing. */
  getReportRowId: (channel: string, reportDate: string, presetId: number | null) => number | null;
  /**
   * Optional share-link config. When BOTH `signingKey` AND `publicBaseUrl`
   * are set the IM push body gains a `📖 View in browser` footer with a
   * signed share URL. Either missing → push body has no footer (the digest
   * still ships in IM unaffected). Designed so a deployment that hasn't
   * configured the public web origin can still rely on IM digest delivery.
   */
  signingKey?: string;
  /** TTL in days for the mint payload. Defaults to 14 when share link is configured. */
  ttlDays?: number;
  /** Absolute public base URL for share link (e.g. "https://digest.example.com"). */
  publicBaseUrl?: string;
}

export interface PushHandle {
  start(): void;
  drain(): Promise<void>;
  runOnce(): Promise<void>;
}

/**
 * Stop hammering a subscription once it has failed this many consecutive
 * ticks in a row. Chosen as 3 so transient blips (1–2 flakes) are still
 * retried immediately, but a durable break (bad preset, expired auth,
 * LLM 4xx) doesn't keep burning LLM quota every 60s.
 */
const PUSH_FAILURE_THRESHOLD = 3;

/**
 * After the threshold trips, silently skip the subscription for this window.
 * 1h balances: long enough that retries don't pile up (~1 attempt/hour
 * instead of ~60/hour), short enough that the fix ("I rotated the key")
 * takes effect within a reasonable deploy→observe loop.
 */
const PUSH_SUPPRESS_WINDOW_MS = 60 * 60 * 1000;

interface PushFailureState {
  /** Consecutive failures observed since the last success. */
  consecutive: number;
  /** When non-null and > now, the sub is silently skipped until this ms epoch. */
  suppressUntil: number | null;
}

/**
 * Today's push-time boundary as a UTC ms timestamp, interpreted in `tz`.
 *
 * Thin wrapper around `epochMsForLocal` in `@goldpan/core/lib/tz`. The
 * scheduler asks "for the calendar day that `now` lands on in `tz`, what
 * epoch ms is `pushTime` of that day?" — `localYMD` picks the calendar day,
 * `epochMsForLocal` does the wall-clock → epoch transform. Correctly handles
 * the full IANA offset range `[-12h, +14h]` including half- and quarter-hour
 * offsets (Asia/Kolkata +5:30, Pacific/Chatham +12:45) and DST.
 *
 * Earlier impl tried to derive the offset from hh+minute alone with a ±720
 * wrap and broke UTC+13 / +14 / +12:45 by wrapping the boundary 24h the wrong
 * way. See `epochMsForLocal` JSDoc for the algorithm.
 */
function todayAtPushTime(now: Date, pushTime: string, tz: string): number {
  const [hh, mm] = pushTime.split(':').map((n) => Number(n));
  return epochMsForLocal(localYMD(now, tz), hh, mm, tz);
}

/**
 * Per-subscription push scheduler. On each tick (or manual `runOnce()`), iterate
 * the due subscriptions, filter paused/not-yet-due/already-pushed-today, then
 * generate the preset's digest, persist the snapshot via `saveReport`, and send
 * it via `sendOutbound`. When the preset has `skipEmpty` and the result is
 * fully empty, `markPushed` still fires (to advance `last_pushed_at`) and the
 * snapshot is still persisted, but delivery is skipped.
 *
 * `drain()` clears the timer and waits for the current tick to finish, so
 * startup→shutdown cycles never leak partial pushes.
 */
export function createPushScheduler(deps: PushDeps): PushHandle {
  const tickMs = deps.tickIntervalMs ?? 60_000;
  const now = deps.now ?? (() => new Date());
  const language = deps.channelLanguage ?? ((): 'en' | 'zh' => 'en');

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const inflight = new Set<Promise<unknown>>();
  /**
   * In-memory per-subscription failure bookkeeping. Cleared on success so
   * transient failures don't poison subsequent ticks. Non-persistent: a
   * process restart gives every sub a fresh chance, which is the right
   * behavior for a scheduler that only pushes one digest per sub per day.
   */
  const failureStates = new Map<number, PushFailureState>();

  async function runOnce(): Promise<void> {
    const currentNow = now();
    const currentNowMs = currentNow.getTime();
    // Capture tz once per tick — every tz-sensitive computation below
    // (boundary, weekday, content-date) must use the same snapshot, else a
    // mid-tick `GOLDPAN_TIMEZONE` commit could fire some subs on the old tz
    // and others on the new tz. Re-reading on each tick (not at scheduler
    // construction) is what makes hot-reload work; see `getTimezone` JSDoc.
    const tz = deps.getTimezone();
    // Same "yesterday" for every subscription in this tick — hoist above the
    // loop so the catch-log payload can reference it without re-computation.
    const date = yesterdayLocalISO(currentNow, tz);
    for (const sub of deps.listDueSubscriptions()) {
      // Permanent-failure throttle: a sub that has tripped the threshold is
      // silently skipped until its suppress window expires. No warn here — we
      // already logged at the transition in the previous tick's catch block.
      const state = failureStates.get(sub.id);
      if (state?.suppressUntil != null && state.suppressUntil > currentNowMs) continue;
      // Per-subscription try/catch: one failing subscription (bad preset,
      // LLM error, network glitch during sendOutbound, DB locked during
      // saveReport, …) must not starve the rest of the tick. `backfill.ts`
      // and `data-snapshot.ts` already isolate per-channel the same way.
      try {
        if (sub.paused) continue;
        const boundary = todayAtPushTime(currentNow, sub.pushTime, tz);
        if (currentNow.getTime() < boundary) continue;
        // Dedupe by *delivered content date*, not by a shifting push-time
        // boundary. The rendered digest body is always
        // `yesterdayLocalISO(pushTime, tz)`, so two deliveries whose content-dates
        // match deliver the same body — and that is the user-visible
        // duplicate we must prevent. Boundary-based dedupe (old logic) fails
        // when pushTime moves later (09:00 → 10:00): the stored
        // `lastPushedAt = T09:00` sits below `T10:00`, so the scheduler
        // re-fires the same digest a second time the same day. Calendar-day
        // dedupe (an earlier attempt) is almost right but mis-skips when a
        // late 23:30 push crosses UTC midnight. Keying on the content date
        // covers both: once we've delivered yesterday's digest for a given
        // `yesterdayLocalISO()`, don't redeliver it until the content date
        // advances.
        if (sub.lastPushedAt !== null) {
          const lastContentDate = yesterdayLocalISO(new Date(sub.lastPushedAt), tz);
          if (lastContentDate === date) continue;
        }
        const preset = deps.getPreset(sub.presetId);
        if (!preset) continue;
        // Weekly presets fire only on their configured ISO weekday
        // (1=Mon..7=Sun). Without this gate the scheduler treated every
        // weekly preset as daily — `preset.period` / `preset.pushDay` were
        // never consulted and a weekly subscription sent a one-day digest
        // every day instead of a 7-day digest on its chosen weekday.
        // `localWeekday` returns ISO 1..7 (Mon..Sun) directly in the
        // configured tz, so no manual Sunday-fold + no UTC-vs-local
        // weekday skew on tz boundaries (a Sun UTC late-night push for a
        // Mon-pushDay preset in Asia/Shanghai now correctly fires).
        if (preset.period === 'weekly') {
          const isoDay = localWeekday(currentNow, tz);
          if (preset.pushDay !== isoDay) continue;
        }
        if (deps.canSendChannel && !deps.canSendChannel(sub.channelId)) continue;
        const lang = language(sub.channelId);
        const result = await deps.generate(
          {
            channel: sub.channelId,
            date,
            presetId: preset.id,
          },
          preset,
        );
        if (result.status !== 'complete') {
          throw new Error(
            `DIGEST_PARTIAL_RESULT: ${sub.channelId}/${date}/${preset.id} produced a partial snapshot`,
          );
        }
        // Persist the snapshot whether or not we end up delivering it — a
        // `skipEmpty` skip still rolls the subscription forward and an
        // equivalent row should exist for the /digest intent to pick up.
        await deps.saveReport(sub.channelId, result);
        const markAt = currentNow.getTime();
        if (preset.skipEmpty && deps.isFullyEmpty(result)) {
          deps.markPushed(sub.id, markAt);
          failureStates.delete(sub.id);
          continue;
        }

        const rowId = deps.getReportRowId(
          result.snapshot.digestId.channel,
          result.snapshot.digestId.date,
          result.snapshot.digestId.presetId,
        );

        // 只有 (signingKey && publicBaseUrl && rowId) 全有才 append footer；
        // 否则纯 IM body —— 让缺配置 / DB 读不到的实例仍能正常发送 IM 日报。
        const signingKey = deps.signingKey;
        const publicBaseUrl = deps.publicBaseUrl;
        let body: string;
        if (rowId === null) {
          // DB 一致性问题（saveReport 刚写完读不到）→ logger.error 而非 warn,
          // 区别于配置缺失（startup 已 warn 一次）。
          deps.logger?.error('digest push: rowId lookup failed after saveReport', {
            digestId: result.snapshot.digestId,
          });
          body = deps.renderIM(result, preset, lang);
        } else if (signingKey && publicBaseUrl) {
          const url = mintShareUrl({
            digestId: rowId,
            signingKey,
            ttlDays: deps.ttlDays ?? 14,
            publicBaseUrl,
          });
          body =
            deps.renderIM(result, preset, lang) +
            '\n\n' +
            IM_SHARE_FOOTER[lang].replace('{url}', url);
        } else {
          // 缺 signingKey 或 publicBaseUrl 时 footer 静默消失对 operator 不可见
          // (postInit 启动时已 warn 一次,这里再 debug 一次方便对账)。
          deps.logger?.debug('digest push: no share footer (signingKey/publicBaseUrl missing)', {
            digestId: result.snapshot.digestId,
            hasSigningKey: !!signingKey,
            hasPublicBaseUrl: !!publicBaseUrl,
          });
          body = deps.renderIM(result, preset, lang);
        }

        await deps.sendOutbound(sub.channelId, sub, {
          type: 'content',
          text: body,
          format: 'markdown',
        });
        deps.markPushed(sub.id, markAt);
        failureStates.delete(sub.id);
      } catch (err) {
        const prev = failureStates.get(sub.id)?.consecutive ?? 0;
        const consecutive = prev + 1;
        const suppressUntil =
          consecutive >= PUSH_FAILURE_THRESHOLD ? currentNowMs + PUSH_SUPPRESS_WINDOW_MS : null;
        failureStates.set(sub.id, { consecutive, suppressUntil });
        deps.logger?.warn('digest push scheduler subscription failed', {
          subscriptionId: sub.id,
          channelId: sub.channelId,
          presetId: sub.presetId,
          date,
          consecutiveFailures: consecutive,
          suppressedUntil: suppressUntil,
          error: errorMessage(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(tick, tickMs);
    const t = timer as { unref?: () => void };
    t.unref?.();
  }

  function tick(): void {
    timer = null;
    if (stopped) return;
    const p = runOnce().catch((err) => {
      deps.logger?.warn('digest push scheduler tick failed', {
        error: errorMessage(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    });
    inflight.add(p);
    p.finally(() => {
      inflight.delete(p);
    });
    scheduleNext();
  }

  return {
    start(): void {
      scheduleNext();
    },
    async runOnce(): Promise<void> {
      await runOnce();
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
