/**
 * 跨 server + web 共享的时区工具集。零依赖，纯函数。
 *
 * 所有"取本地某字段"函数都用 `Intl.DateTimeFormat(undefined, { timeZone, ...parts })`
 * + `formatToParts` 抽字段而不用 `getUTC*` 加偏移 — `Intl` 内置 IANA 数据
 * 自动处理 DST、历史 offset 变化，且 fixed-offset (`Etc/GMT±N`) 也走同
 * 一套 API。
 */

/**
 * 探测 host 时区。优先级:
 *   1. process.env.TZ (容器 / docker run -e TZ=... 显式设置)
 *   2. Intl.DateTimeFormat().resolvedOptions().timeZone (host 系统时区)
 *   3. fallback 'UTC' (两个 probe 都返回 invalid 或空)
 */
export function detectHostTimezone(): string {
  const envTz = process.env.TZ;
  if (envTz && isValidIanaTz(envTz)) return envTz;
  try {
    const intl = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (intl && isValidIanaTz(intl)) return intl;
  } catch {
    // fall through
  }
  return 'UTC';
}

/**
 * 校验是否合法 IANA tz string。用 `Intl.DateTimeFormat({timeZone})` probe —
 * 抛 RangeError 则非法。
 *
 * 额外要求输入必须与 `resolvedOptions().timeZone` 大小写无关相等,目的是
 * 拒绝 ICU 的歧义缩写映射 (如 `CST` → `America/Chicago`、`PST` →
 * `America/Los_Angeles`、`EST` → `America/Panama`)。这些缩写在不同语境含义
 * 不同,作为时区配置极易误用,必须强制用 `Region/City` 形式。
 *
 * **UTC 别名特殊放行**: ICU 把 `Etc/GMT` / `Etc/UTC` / `GMT` / `Universal` /
 * `Etc/GMT+0` 等都 canonicalize 成 `UTC`。这些是没有歧义的 UTC 同义词
 * (与 CST/PST 的"同一缩写多个 tz"问题正交),所以 canonical === 'UTC' 时
 * 直接接受输入,不再要求字面与 canonical 相等 —— 否则 onboarding offset
 * picker 的 `Etc/GMT` 默认值和任何用户配置 `GOLDPAN_TIMEZONE=Etc/UTC` /
 * `GMT` 的部署都会被 commit 拒绝。
 */
export function isValidIanaTz(s: string): boolean {
  if (!s || typeof s !== 'string') return false;
  try {
    const canonical = new Intl.DateTimeFormat(undefined, { timeZone: s }).resolvedOptions()
      .timeZone;
    if (canonical === 'UTC') return true;
    return canonical.toLowerCase() === s.toLowerCase();
  } catch {
    return false;
  }
}

export function localHourMinute(d: Date, tz: string): { hh: number; mm: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  let hh = 0;
  let mm = 0;
  for (const p of parts) {
    if (p.type === 'hour') hh = Number(p.value);
    if (p.type === 'minute') mm = Number(p.value);
  }
  if (hh === 24) hh = 0;
  return { hh, mm };
}

export function localYMD(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  let y = '';
  let m = '';
  let day = '';
  for (const p of parts) {
    if (p.type === 'year') y = p.value;
    if (p.type === 'month') m = p.value;
    if (p.type === 'day') day = p.value;
  }
  return `${y}-${m}-${day}`;
}

export function localWeekday(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  }).formatToParts(d);
  const tag = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const map: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  const n = map[tag];
  if (n === undefined) {
    // `Intl.DateTimeFormat('en-US', { weekday: 'short' })` always emits exactly
    // one of Mon/Tue/Wed/Thu/Fri/Sat/Sun — reaching here implies ICU broke.
    // Throw so a surprise is loud rather than silently mapped to Monday.
    throw new Error(`unreachable: unexpected weekday tag "${tag}" from Intl`);
  }
  return n;
}

/**
 * 把 "在 tz 时区里的某个墙钟时刻 (YYYY-MM-DD HH:MM)" 翻译成 epoch ms。
 *
 * 算法和 `currentOffsetMinutes` 同源:用 `Date.UTC(...)` 同时重建 "要求的
 * 墙钟字段" 和 "Intl probe 出来的字段",两者相减就是 tz 在该时刻的 UTC offset,
 * 再从 provisional 减掉这个 offset 就落到真实 epoch ms。
 *
 * 不能像旧实现那样只比 hh+mm 用 ±12h 修正跨日 —— 真实 IANA 范围是
 * `[-12h, +14h]`,UTC+13 (NZDT)、UTC+14 (Pacific/Kiritimati)、UTC+12:45
 * (Pacific/Chatham) 都会被 ±720 wrap 算错方向。把 "日" 一起放进 `Date.UTC`
 * 差值就精确覆盖整个范围 + 半小时 / 45 分钟 offset。
 *
 * DST 前跳日 (e.g. US spring-forward 当天的 02:30 不存在): Intl 会把
 * 不存在的本地时间映射到一小时后的 UTC 时刻。每日 02:30 push 会错过 spring
 * 那一天 —— 我们接受这个行为(原样暴露给用户的配置问题),不要静默偏移。
 */
export function epochMsForLocal(ymd: string, hh: number, mm: number, tz: string): number {
  const [y, mo, d] = ymd.split('-').map(Number);
  const provisionalUtcMs = Date.UTC(y, mo - 1, d, hh, mm, 0, 0);
  // 把 provisional 当成 UTC 时刻交给 Intl,问它在目标 tz 里显示什么墙钟字段。
  // 要求字段(y/mo/d/hh/mm) 和观测字段的 Date.UTC 差值 = tz 在该日的 offset。
  const observed = extractTzFields(new Date(provisionalUtcMs), tz);
  const observedUtcMs = Date.UTC(
    observed.year,
    observed.month - 1,
    observed.day,
    observed.hour,
    observed.minute,
  );
  const offsetMs = observedUtcMs - provisionalUtcMs;
  return provisionalUtcMs - offsetMs;
}

export function formatTzLabel(tz: string): string {
  if (tz === 'UTC') return 'UTC';
  const offset = currentOffsetMinutes(tz);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  const offsetLabel =
    minutes === 0 ? `UTC${sign}${hours}` : `UTC${sign}${hours}:${String(minutes).padStart(2, '0')}`;
  if (tz.startsWith('Etc/GMT')) return offsetLabel;
  return `${tz} (${offsetLabel})`;
}

function currentOffsetMinutes(tz: string): number {
  // 抽 UTC + 目标 tz 当下"本地墙钟"的 year/month/day/hh/mm,各自塞回
  // `Date.UTC(...)` 得到两个无时区参考的毫秒数,直接相减就是 offset。
  //
  // 不能像旧实现那样只比 hh+mm 然后用 ±720 修正跨日: 该方法在 |offset| > 12h
  // (Pacific/Kiritimati UTC+14、Pacific/Chatham UTC+12:45 等) 会把跨日往
  // 错方向修正,把 UTC+14 算成 UTC-10。把"日"也纳入差值就能精确支持完整
  // -12..+14 IANA 范围加半小时 / 45 分钟 offset。
  const now = new Date();
  const utcFields = extractTzFields(now, 'UTC');
  const localFields = extractTzFields(now, tz);
  const utcMs = Date.UTC(
    utcFields.year,
    utcFields.month - 1,
    utcFields.day,
    utcFields.hour,
    utcFields.minute,
  );
  const localMs = Date.UTC(
    localFields.year,
    localFields.month - 1,
    localFields.day,
    localFields.hour,
    localFields.minute,
  );
  return Math.round((localMs - utcMs) / 60_000);
}

function extractTzFields(
  d: Date,
  tz: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hour = get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // Intl `hour12: false` 偶发返回 24 而非 0,做一次归一。
    hour: hour === 24 ? 0 : hour,
    minute: get('minute'),
  };
}
