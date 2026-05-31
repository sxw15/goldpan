import type { Language } from '@goldpan/core/i18n';
import { epochMsForLocal, localYMD } from '@goldpan/core/lib/tz';
import type { ChannelSlot, Period, WindowMode } from '../types.js';

const DAY_MS = 24 * 3600 * 1000;

type HeadingMap = Record<Exclude<ChannelSlot, 'ai_summary'>, string> & {
  ai_summary: string;
  title_daily: string;
  title_weekly: string;
  empty_section: string;
  full_empty: string;
  more_footer: (n: number) => string;
};

export const HEADINGS: Record<Language, HeadingMap> = {
  en: {
    tracking_findings: 'Tracking Findings',
    captures: 'Captures',
    thoughts: 'Thoughts',
    new_entities: 'New Entities',
    stats: 'Stats',
    ai_summary: 'Summary',
    title_daily: 'Daily Digest',
    title_weekly: 'Weekly Digest',
    empty_section: '— no entries —',
    full_empty: 'Nothing to report for this period.',
    more_footer: (n: number) => `… and ${n} more (hidden)`,
  },
  zh: {
    tracking_findings: '追踪发现',
    captures: '收录',
    thoughts: '想法',
    new_entities: '新增实体',
    stats: '统计',
    ai_summary: '摘要',
    title_daily: '每日日报',
    title_weekly: '每周日报',
    empty_section: '— 无记录 —',
    full_empty: '本周期暂无内容。',
    more_footer: (n: number) => `……另有 ${n} 条（已隐藏）`,
  },
};

export const IM_SHARE_FOOTER: Record<Language, string> = {
  zh: '📖 在浏览器查看：{url}',
  en: '📖 View in browser: {url}',
};

/**
 * Format an epoch-millis timestamp as a locale-aware short date string
 * suitable for digest line items.
 *
 * tz is intentionally required (no default) — without it `toLocaleDateString`
 * uses the host process tz, which on Docker hosts (default UTC) is decoupled
 * from `GOLDPAN_TIMEZONE`. A digest keyed by `yesterdayLocalISO(now, tz)`
 * would then render entry dates 8h off — see render/helpers.ts JSDoc on
 * `yesterdayLocalISO` for the same rationale. Falls back to ISO date if the
 * locale formatting is unavailable.
 */
export function formatDate(ts: number, language: Language, tz: string): string {
  const date = new Date(ts);
  try {
    return date.toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: tz,
    });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Compute yesterday's date in the given tz as an ISO YYYY-MM-DD string.
 * Used by intent handler + postInit backfill + schedulers; must match the
 * tz convention so daily_reports rows align across touch-points.
 *
 * tz is intentionally required (no default) — every callsite has a live tz
 * source (configStore in production, explicit fixture in tests) and a silent
 * 'UTC' fallback would mask wiring bugs.
 */
export function yesterdayLocalISO(now: Date, tz: string): string {
  const d = new Date(now.getTime() - 24 * 3600 * 1000);
  return localYMD(d, tz);
}

export function titleFor(period: Period, language: Language): string {
  return period === 'weekly' ? HEADINGS[language].title_weekly : HEADINGS[language].title_daily;
}

/**
 * Shift a `YYYY-MM-DD` string by an integer number of calendar days.
 * Anchored on `Date.UTC` so month/year boundaries are correct and DST
 * doesn't slip the calendar day — the returned YMD is then resolved to
 * the actual UTC instant of *that day's local midnight* by
 * `epochMsForLocal(ymd, 0, 0, tz)`, which absorbs any DST shift.
 */
export function shiftDateYMD(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Compute the SQL `WHERE created_at BETWEEN from AND to` window for a digest
 * keyed by `date` (user-local YMD), `period`, and `windowMode`.
 *
 * - `calendar` (default): Edges are user-local midnight in `tz` — a 'daily'
 *   digest for SHA 5/13 reads SHA 5/13 00:00..23:59:59.999 (not UTC 5/13,
 *   which would lag 8h behind in Asia/Shanghai). Weekly walks back
 *   (spanDays-1) calendar days from `date`. `anchorMs` is ignored.
 * - `rolling`: Sliding window anchored at `anchorMs` (default `Date.now()`).
 *   Daily = `[anchor-24h, anchor]`, weekly = `[anchor-7d, anchor]`. `date`/`tz`
 *   are ignored — the snapshot row's `date` field is still set by the caller
 *   for indexing,but the window itself is purely time-relative.
 *
 * Centralized so backfill, daily cron, push scheduler, intent handler, and
 * `/digest/preview` share one source of truth. Optional `options` param keeps
 * existing 3-arg callsites source-compatible (calendar mode is the default).
 */
export function computeDigestRange(
  date: string,
  period: Period,
  tz: string,
  options?: { windowMode?: WindowMode; anchorMs?: number },
): { from: number; to: number } {
  const mode = options?.windowMode ?? 'calendar';
  if (mode === 'rolling') {
    const anchorMs = options?.anchorMs ?? Date.now();
    const spanMs = period === 'weekly' ? 7 * DAY_MS : DAY_MS;
    return { from: anchorMs - spanMs, to: anchorMs };
  }
  const spanDays = period === 'weekly' ? 7 : 1;
  const fromYMD = spanDays > 1 ? shiftDateYMD(date, -(spanDays - 1)) : date;
  const toYMD = shiftDateYMD(date, 1);
  const from = epochMsForLocal(fromYMD, 0, 0, tz);
  const to = epochMsForLocal(toYMD, 0, 0, tz) - 1;
  return { from, to };
}
