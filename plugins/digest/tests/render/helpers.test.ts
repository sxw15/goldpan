import { describe, expect, it } from 'vitest';
import {
  computeDigestRange,
  formatDate,
  shiftDateYMD,
  yesterdayLocalISO,
} from '../../src/render/helpers.js';

describe('yesterdayLocalISO', () => {
  it('returns yesterday in the given tz', () => {
    // 2026-05-14T17:00:00Z = 2026-05-15 01:00 Asia/Shanghai → yesterday is 2026-05-14
    const now = new Date('2026-05-14T17:00:00Z');
    expect(yesterdayLocalISO(now, 'Asia/Shanghai')).toBe('2026-05-14');
  });

  it('returns UTC yesterday when tz is UTC', () => {
    const now = new Date('2026-05-14T00:00:30Z');
    expect(yesterdayLocalISO(now, 'UTC')).toBe('2026-05-13');
  });

  it('handles fixed-offset Etc/GMT', () => {
    // 2026-05-14T03:00:00Z = 2026-05-13 22:00 Etc/GMT+5 (UTC-5)
    const now = new Date('2026-05-14T03:00:00Z');
    expect(yesterdayLocalISO(now, 'Etc/GMT+5')).toBe('2026-05-12');
  });
});

describe('formatDate', () => {
  // Regression for A3: digest line items used to render in the host process
  // tz, drifting by the user's offset relative to the digest date key. Lock
  // each render against an explicit tz to keep "5/13 digest" and "5/13 item"
  // mutually consistent across deployments.
  it('renders in the given tz, not the host tz', () => {
    // 2026-05-12T18:00:00Z = Asia/Shanghai 2026-05-13 02:00 (belongs in 5/13 digest)
    const ts = new Date('2026-05-12T18:00:00Z').getTime();
    expect(formatDate(ts, 'en', 'Asia/Shanghai')).toMatch(/May 13|13/);
    expect(formatDate(ts, 'zh', 'Asia/Shanghai')).toMatch(/5月13日|5\/13/);
    // Same instant in UTC is still May 12 — confirms tz argument is honored
    // rather than silently falling back to host.
    expect(formatDate(ts, 'en', 'UTC')).toMatch(/May 12|12/);
  });
});

describe('shiftDateYMD', () => {
  it('shifts by integer days, crossing month/year boundaries', () => {
    expect(shiftDateYMD('2026-05-14', -1)).toBe('2026-05-13');
    expect(shiftDateYMD('2026-05-14', 1)).toBe('2026-05-15');
    expect(shiftDateYMD('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDateYMD('2026-01-31', 1)).toBe('2026-02-01');
    expect(shiftDateYMD('2026-03-29', -6)).toBe('2026-03-23'); // EU DST week
  });
});

describe('computeDigestRange', () => {
  // Regression for A1 + B3: engine.getSnapshot used to literal `T00:00:00Z`
  // edges, so a "5/13" digest in Asia/Shanghai scanned UTC 5/13 = SHA 5/13
  // 08:00..5/14 07:59 (off by 8h, dropped SHA 5/13 morning, leaked SHA 5/14
  // pre-dawn). Lock the corrected behavior: edges must be user-local
  // midnight, not UTC midnight.

  it('daily range is user-local midnight to next-day midnight - 1ms (Asia/Shanghai)', () => {
    const { from, to } = computeDigestRange('2026-05-13', 'daily', 'Asia/Shanghai');
    // SHA 5/13 00:00 = UTC 2026-05-12T16:00
    expect(new Date(from).toISOString()).toBe('2026-05-12T16:00:00.000Z');
    // SHA 5/14 00:00 - 1ms = UTC 2026-05-13T15:59:59.999
    expect(new Date(to).toISOString()).toBe('2026-05-13T15:59:59.999Z');
  });

  it('daily range collapses to UTC midnight when tz is UTC', () => {
    const { from, to } = computeDigestRange('2026-05-13', 'daily', 'UTC');
    expect(new Date(from).toISOString()).toBe('2026-05-13T00:00:00.000Z');
    expect(new Date(to).toISOString()).toBe('2026-05-13T23:59:59.999Z');
  });

  it('weekly range walks back 6 days from anchor in user tz', () => {
    const { from, to } = computeDigestRange('2026-05-13', 'weekly', 'Asia/Shanghai');
    // SHA 5/7 00:00 = UTC 2026-05-06T16:00
    expect(new Date(from).toISOString()).toBe('2026-05-06T16:00:00.000Z');
    expect(new Date(to).toISOString()).toBe('2026-05-13T15:59:59.999Z');
  });

  it('weekly range crossing DST in America/New_York absorbs the shift', () => {
    // 2026-11-01 is NY fall-back (02:00 EDT → 01:00 EST). Weekly anchor =
    // 11/01 spans NY local 10/26 00:00..11/01 23:59. EDT is UTC-4; EST is
    // UTC-5; the wall-clock-to-UTC mapping flips during the week.
    const { from, to } = computeDigestRange('2026-11-01', 'weekly', 'America/New_York');
    // NY 10/26 00:00 EDT (UTC-4) = UTC 10/26 04:00
    expect(new Date(from).toISOString()).toBe('2026-10-26T04:00:00.000Z');
    // NY 11/02 00:00 EST (UTC-5) - 1ms = UTC 11/02 04:59:59.999
    expect(new Date(to).toISOString()).toBe('2026-11-02T04:59:59.999Z');
  });

  it('rolling daily: [anchor-24h, anchor]; date/tz ignored', () => {
    const anchorMs = new Date('2026-05-13T15:30:00.000Z').getTime();
    // 故意传一个 date 与 anchor 不同的日期 + 一个非 UTC tz,验证 rolling 分支
    // 完全不读它们 —— from/to 完全由 anchorMs 决定。
    const r1 = computeDigestRange('2099-01-01', 'daily', 'Asia/Shanghai', {
      windowMode: 'rolling',
      anchorMs,
    });
    expect(r1.from).toBe(anchorMs - 24 * 3600 * 1000);
    expect(r1.to).toBe(anchorMs);
    // 在 UTC 下同 anchorMs 出同样的 from/to,证明 tz 无副作用。
    const r2 = computeDigestRange('2026-05-13', 'daily', 'UTC', {
      windowMode: 'rolling',
      anchorMs,
    });
    expect(r2.from).toBe(r1.from);
    expect(r2.to).toBe(r1.to);
  });

  it('rolling weekly: [anchor-7d, anchor]', () => {
    const anchorMs = new Date('2026-05-13T15:30:00.000Z').getTime();
    const r = computeDigestRange('2026-05-13', 'weekly', 'Asia/Shanghai', {
      windowMode: 'rolling',
      anchorMs,
    });
    expect(r.from).toBe(anchorMs - 7 * 24 * 3600 * 1000);
    expect(r.to).toBe(anchorMs);
  });

  it('rolling default anchor falls back to Date.now()', () => {
    // 时间敏感测试:不传 anchorMs 时用 Date.now() —— from/to 应紧贴当前实时。
    const before = Date.now();
    const r = computeDigestRange('2026-05-13', 'daily', 'UTC', { windowMode: 'rolling' });
    const after = Date.now();
    // 容差 = 取范围执行期间的 wall clock 漂移上限(几 ms)。
    expect(r.to).toBeGreaterThanOrEqual(before);
    expect(r.to).toBeLessThanOrEqual(after);
    expect(r.to - r.from).toBe(24 * 3600 * 1000);
  });

  it('explicit windowMode: "calendar" matches the default 3-arg form', () => {
    // 锁定向后兼容:加 windowMode 参数后,显式传 calendar 必须与不传选项的行为
    // 完全等价 —— 任何旧 callsite(只传 date/period/tz)不会因新参数改变窗口。
    const a = computeDigestRange('2026-05-13', 'daily', 'Asia/Shanghai');
    const b = computeDigestRange('2026-05-13', 'daily', 'Asia/Shanghai', {
      windowMode: 'calendar',
    });
    expect(a).toEqual(b);
  });
});
