import { localYMD } from '@goldpan/core/lib/tz';

/**
 * 相对时间格式化 — 复用既有 `time.*` i18n key (task popover / chat /
 * conversations 共享)。tz 用于阈值边界 (e.g. "30 天前" 退化到本地日历日)
 * 和将来日期。
 *
 * 签名对齐 next-intl `useTranslations(...)` Translator 返回类型 — values
 * 限定为 ICU 支持的 string / number / Date。
 */
export function formatRelativeTime(
  ms: number,
  t: (key: string, values?: Record<string, string | number | Date>) => string,
  tz: string = 'UTC',
): string {
  if (!Number.isFinite(ms)) return String(ms);
  const now = Date.now();
  const diffMs = now - ms;
  if (diffMs < 0) return formatDateMinute(ms, tz);
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return t('just_now');
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t('minutes_ago', { count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t('hours_ago', { count: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return t('yesterday');
  if (diffDay < 30) return t('days_ago', { count: diffDay });
  return localYMD(new Date(ms), tz);
}

export type FreqKey =
  | 'freq_hourly'
  | 'freq_daily'
  | 'freq_weekly'
  | 'freq_minutes'
  | 'freq_hours'
  | 'every_n_minutes';

export function freqDescriptor(intervalMinutes: number): { key: FreqKey; n?: number } {
  if (intervalMinutes === 60) return { key: 'freq_hourly' };
  if (intervalMinutes === 1440) return { key: 'freq_daily' };
  if (intervalMinutes === 10080) return { key: 'freq_weekly' };
  if (intervalMinutes < 60) return { key: 'freq_minutes', n: intervalMinutes };
  if (intervalMinutes % 60 === 0) return { key: 'freq_hours', n: intervalMinutes / 60 };
  return { key: 'every_n_minutes', n: intervalMinutes };
}

export function formatDateMinute(ms: number, tz: string = 'UTC'): string {
  const date = new Date(ms);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  let y = '';
  let mo = '';
  let d = '';
  let h = '';
  let m = '';
  for (const p of parts) {
    if (p.type === 'year') y = p.value;
    if (p.type === 'month') mo = p.value;
    if (p.type === 'day') d = p.value;
    if (p.type === 'hour') h = p.value;
    if (p.type === 'minute') m = p.value;
  }
  // Intl `hour12: false` 偶发返回 24 而非 00（午夜边界），归一为 00。
  if (h === '24') h = '00';
  return `${y}-${mo}-${d} ${h}:${m}`;
}

export function formatDateOnly(ms: number, tz: string = 'UTC'): string {
  return localYMD(new Date(ms), tz);
}

export function formatTimeOfDay(ms: number, tz: string = 'UTC'): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    console.warn('formatTimeOfDay: bad input', ms);
    return String(ms);
  }
  return d.toLocaleTimeString('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatTimeOfDayMs(ms: number, tz: string = 'UTC'): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    console.warn('formatTimeOfDayMs: bad input', ms);
    return String(ms);
  }
  const base = d.toLocaleTimeString('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return `${base}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function todayLocal(tz: string = 'UTC'): string {
  return localYMD(new Date(), tz);
}

export function yesterdayLocal(tz: string = 'UTC'): string {
  return localYMD(new Date(Date.now() - 86_400_000), tz);
}

/** Anchor to UTC midnight so day-boundary shifts don't slip across DST. */
export function shiftLocalDate(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000;
  return localYMD(new Date(t), 'UTC');
}

/**
 * convert unix-ms timestamp to HTML5 `<input type="datetime-local">`
 * value (YYYY-MM-DDTHH:mm) in given IANA tz. Returns '' for null input.
 */
export function formatLocalDateTimeInput(ms: number | null, tz: string): string {
  if (ms === null) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  if (!map.year || !map.month || !map.day || !map.hour || !map.minute) return '';
  // Intl 在午夜 hour: '2-digit' hour12: false 可能返回 '24' — 规整为 '00'
  const hh = map.hour === '24' ? '00' : map.hour;
  return `${map.year}-${map.month}-${map.day}T${hh}:${map.minute}`;
}

const DATETIME_LOCAL_REGEX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * parse HTML5 datetime-local value back to unix ms, interpreting the
 * naive datetime in the given IANA tz. Returns null for empty / malformed.
 *
 * Strategy: 把 naive y/m/d/h/m 当 UTC 字段算个 provisional epoch ms, 然后
 * 经 `formatLocalDateTimeInput` 在目标 tz 里 round-trip 得到 back，再用
 * back vs trimmed 的差值（drift）一步修正 candidate；正常 tz 1-2 轮内
 * round-trip == trimmed 即收敛。
 *
 * DST spring-forward gap (e.g. 2026-03-08T02:30 America/New_York 不存在,
 * 因为 02:00 直接跳到 03:00 EDT): 迭代不收敛。策略对齐
 * `@goldpan/core/lib/tz.ts:epochMsForLocal` —— 接受 Intl 默认行为, 把
 * 不存在的墙钟映射到 "下一个有效墙钟" (即 round-trip 后 back > trimmed
 * 的最小 candidate); 跨 4 次迭代后仍未收敛时, 返回该 candidate, 而不是
 * 让旧实现 "硬退" 出一个 round-trip 反而比输入更早的 jitter 结果。
 *
 * DST fall-back ambiguity (e.g. 2026-11-01T01:30 NY 出现两次): 第一次
 * round-trip 就命中其中一个有效 epoch ms (= EDT 那一支), 不再纠结。
 */
export function parseLocalDateTimeInput(value: string, tz: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const m = DATETIME_LOCAL_REGEX.exec(trimmed);
  if (!m) return null;
  const [, year, month, day, hour, minute] = m.map(Number);
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = desiredAsUtc;
  // Round-trip 后 wall-clock 严格晚于 trimmed 的最小 candidate —— DST gap 兜底。
  // YYYY-MM-DDTHH:mm 字符串按字典序比较即时间顺序。
  let gapNextValid: { candidate: number; back: string } | null = null;
  for (let i = 0; i < 4; i++) {
    const back = formatLocalDateTimeInput(candidate, tz);
    if (back === trimmed) return candidate;
    if (back > trimmed && (gapNextValid === null || back < gapNextValid.back)) {
      gapNextValid = { candidate, back };
    }
    const bm = DATETIME_LOCAL_REGEX.exec(back);
    if (!bm) return null;
    const [, by, bmon, bd, bh, bmi] = bm.map(Number);
    const drift = desiredAsUtc - Date.UTC(by, bmon - 1, bd, bh, bmi, 0);
    if (drift === 0) return candidate;
    candidate += drift;
  }
  // 没收敛 — DST spring-forward gap。返回 next valid wall-clock。
  return gapNextValid !== null ? gapNextValid.candidate : candidate;
}
