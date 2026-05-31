import { describe, expect, it, vi } from 'vitest';
import {
  detectHostTimezone,
  epochMsForLocal,
  formatTzLabel,
  isValidIanaTz,
  localHourMinute,
  localWeekday,
  localYMD,
} from '../../src/lib/tz';

describe('isValidIanaTz', () => {
  it('accepts canonical IANA names', () => {
    expect(isValidIanaTz('Asia/Shanghai')).toBe(true);
    expect(isValidIanaTz('America/New_York')).toBe(true);
    expect(isValidIanaTz('UTC')).toBe(true);
    expect(isValidIanaTz('Etc/GMT-8')).toBe(true);
  });

  it('accepts unambiguous UTC aliases (ICU canonicalizes to UTC)', () => {
    // 回归锁定 onboarding offset picker `n===0` 路径 (Etc/GMT) 和任何把
    // GOLDPAN_TIMEZONE 设为 UTC 同义词的部署都能通过 commit 校验。
    expect(isValidIanaTz('Etc/GMT')).toBe(true);
    expect(isValidIanaTz('Etc/UTC')).toBe(true);
    expect(isValidIanaTz('GMT')).toBe(true);
    expect(isValidIanaTz('Universal')).toBe(true);
    expect(isValidIanaTz('Etc/GMT+0')).toBe(true);
    expect(isValidIanaTz('etc/gmt')).toBe(true);
  });

  it('rejects ambiguous abbreviations + garbage', () => {
    expect(isValidIanaTz('CST')).toBe(false);
    expect(isValidIanaTz('PST')).toBe(false);
    expect(isValidIanaTz('foo/bar')).toBe(false);
    expect(isValidIanaTz('')).toBe(false);
  });
});

describe('localHourMinute', () => {
  it('returns local hour and minute for a tz', () => {
    const d = new Date('2026-05-14T00:00:00Z');
    expect(localHourMinute(d, 'Asia/Shanghai')).toEqual({ hh: 8, mm: 0 });
    expect(localHourMinute(d, 'Etc/GMT+5')).toEqual({ hh: 19, mm: 0 });
  });

  it('handles UTC tz', () => {
    const d = new Date('2026-05-14T14:35:23Z');
    expect(localHourMinute(d, 'UTC')).toEqual({ hh: 14, mm: 35 });
  });
});

describe('localYMD', () => {
  it('returns calendar date in the tz', () => {
    const d = new Date('2026-05-14T17:00:00Z');
    expect(localYMD(d, 'Asia/Shanghai')).toBe('2026-05-15');
    expect(localYMD(d, 'Etc/GMT+4')).toBe('2026-05-14');
  });
});

describe('localWeekday', () => {
  it('returns 1=Mon..7=Sun in the tz', () => {
    const thursday = new Date('2026-05-14T12:00:00Z');
    expect(localWeekday(thursday, 'UTC')).toBe(4);

    const sunUtcMonShanghai = new Date('2026-05-17T16:00:00Z');
    expect(localWeekday(sunUtcMonShanghai, 'UTC')).toBe(7);
    expect(localWeekday(sunUtcMonShanghai, 'Asia/Shanghai')).toBe(1);
  });
});

describe('formatTzLabel', () => {
  it('renders "Region/City (UTC±N)" for IANA names', () => {
    const label = formatTzLabel('Asia/Shanghai');
    expect(label).toBe('Asia/Shanghai (UTC+8)');
  });

  it('renders "UTC±N" for Etc/GMT fixed-offset names', () => {
    expect(formatTzLabel('Etc/GMT-8')).toBe('UTC+8');
    expect(formatTzLabel('Etc/GMT+5')).toBe('UTC-5');
    expect(formatTzLabel('Etc/GMT')).toBe('UTC+0');
  });

  it('renders "UTC" verbatim', () => {
    expect(formatTzLabel('UTC')).toBe('UTC');
  });

  it('renders correctly for offsets above +12h', () => {
    expect(formatTzLabel('Etc/GMT-13')).toBe('UTC+13');
    expect(formatTzLabel('Etc/GMT-14')).toBe('UTC+14');
  });

  it('renders correctly for offsets below -10h', () => {
    expect(formatTzLabel('Etc/GMT+11')).toBe('UTC-11');
    expect(formatTzLabel('Etc/GMT+12')).toBe('UTC-12');
  });

  it('renders correctly for half-hour offsets', () => {
    // Asia/Kolkata is UTC+5:30 year-round (no DST).
    expect(formatTzLabel('Asia/Kolkata')).toBe('Asia/Kolkata (UTC+5:30)');
  });
});

describe('epochMsForLocal', () => {
  // Verifies the wall-clock-in-tz → epoch ms conversion across the full
  // IANA offset range. The buggy push.ts impl wrapped offsets into (-12h, +12h]
  // and broke UTC+13 / +14 / +12:45 — these tests lock the correct behavior
  // by spanning -12 ... +14 plus half- and quarter-hour offsets.

  it('returns correct epoch ms for Asia/Shanghai 09:00', () => {
    const ms = epochMsForLocal('2026-05-14', 9, 0, 'Asia/Shanghai');
    // Asia/Shanghai 09:00 = UTC 01:00
    expect(new Date(ms).toISOString()).toBe('2026-05-14T01:00:00.000Z');
  });

  it('handles UTC+14 (Pacific/Kiritimati) correctly', () => {
    const ms = epochMsForLocal('2026-05-14', 9, 0, 'Pacific/Kiritimati');
    // +14 means local 09:00 = UTC 19:00 the PREVIOUS day
    expect(new Date(ms).toISOString()).toBe('2026-05-13T19:00:00.000Z');
  });

  it('handles UTC+13 (Pacific/Auckland NZDT in Jan 2026)', () => {
    const ms = epochMsForLocal('2026-01-15', 9, 0, 'Pacific/Auckland');
    // +13 NZDT in Jan
    expect(new Date(ms).toISOString()).toBe('2026-01-14T20:00:00.000Z');
  });

  it('handles UTC+12:45 (Pacific/Chatham)', () => {
    // Chatham observes CHAST (+12:45) and CHADT (+13:45). May is CHAST.
    const ms = epochMsForLocal('2026-05-14', 9, 0, 'Pacific/Chatham');
    // 09:00 local - 12:45 offset = -3:45 of UTC = 20:15 prev day
    expect(new Date(ms).toISOString()).toBe('2026-05-13T20:15:00.000Z');
  });

  it('handles UTC-12 boundary (Etc/GMT+12)', () => {
    const ms = epochMsForLocal('2026-05-14', 9, 0, 'Etc/GMT+12');
    // Etc/GMT+12 means UTC-12 → local 09:00 = UTC 21:00 same day
    expect(new Date(ms).toISOString()).toBe('2026-05-14T21:00:00.000Z');
  });

  it('handles half-hour offset (Asia/Kolkata +5:30)', () => {
    const ms = epochMsForLocal('2026-05-14', 9, 0, 'Asia/Kolkata');
    // +5:30 means local 09:00 = UTC 03:30
    expect(new Date(ms).toISOString()).toBe('2026-05-14T03:30:00.000Z');
  });
});

describe('detectHostTimezone', () => {
  it('prefers process.env.TZ when set + valid', () => {
    const restore = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    try {
      expect(detectHostTimezone()).toBe('Asia/Tokyo');
    } finally {
      if (restore === undefined) delete process.env.TZ;
      else process.env.TZ = restore;
    }
  });

  it('falls back to Intl resolvedOptions when TZ unset', () => {
    const restore = process.env.TZ;
    delete process.env.TZ;
    // 用 spy 锁定 Intl 返回固定 tz,这样测试不依赖 host 环境且能验证 Intl 路径
    // 真的被走到 (旧版只断言 isValidIanaTz(tz) ≡ true, UTC fallback 也满足,
    // 没能区分 Intl 路径 vs fallback 路径)。
    //
    // 必须用 function 而非 arrow: isValidIanaTz 内部用 `new Intl.DateTimeFormat(...)`
    // 验证 Intl 返回的 tz string, arrow 不能当 constructor 会抛 → 落到 UTC fallback。
    const origDtf = Intl.DateTimeFormat;
    // biome-ignore lint/complexity/useArrowFunction: spyOn 替换的 Intl.DateTimeFormat 需要支持 `new` 调用
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
      ...args: unknown[]
    ): Intl.DateTimeFormat {
      const inst = new origDtf(...(args as Parameters<typeof origDtf>));
      const origResolved = inst.resolvedOptions.bind(inst);
      inst.resolvedOptions = () => ({ ...origResolved(), timeZone: 'Europe/London' });
      return inst;
    } as unknown as typeof Intl.DateTimeFormat);
    try {
      expect(detectHostTimezone()).toBe('Europe/London');
    } finally {
      spy.mockRestore();
      if (restore !== undefined) process.env.TZ = restore;
    }
  });

  it('falls back to UTC when both probes return invalid', () => {
    const restore = process.env.TZ;
    process.env.TZ = 'NOT_A_REAL_TZ';
    const origDtf = Intl.DateTimeFormat;
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(((...args: unknown[]) => {
      const inst = new origDtf(...(args as Parameters<typeof origDtf>));
      const origResolved = inst.resolvedOptions.bind(inst);
      inst.resolvedOptions = () => ({ ...origResolved(), timeZone: '' });
      return inst;
    }) as unknown as typeof Intl.DateTimeFormat);
    try {
      expect(detectHostTimezone()).toBe('UTC');
    } finally {
      spy.mockRestore();
      if (restore === undefined) delete process.env.TZ;
      else process.env.TZ = restore;
    }
  });
});
