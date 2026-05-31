import { describe, expect, it, vi } from 'vitest';
import {
  formatDateMinute,
  formatDateOnly,
  formatLocalDateTimeInput,
  formatTimeOfDay,
  formatTimeOfDayMs,
  freqDescriptor,
  parseLocalDateTimeInput,
  shiftLocalDate,
  todayLocal,
  yesterdayLocal,
} from './format';

describe('formatDateOnly with tz', () => {
  it('returns local YMD for the given tz', () => {
    // 2026-05-14T17:00:00Z = 2026-05-15 01:00 Asia/Shanghai
    const ms = new Date('2026-05-14T17:00:00Z').getTime();
    expect(formatDateOnly(ms, 'Asia/Shanghai')).toBe('2026-05-15');
    expect(formatDateOnly(ms, 'UTC')).toBe('2026-05-14');
  });
});

describe('formatDateMinute with tz', () => {
  it('returns "YYYY-MM-DD HH:MM" in the given tz', () => {
    const ms = new Date('2026-05-14T17:00:00Z').getTime();
    expect(formatDateMinute(ms, 'Asia/Shanghai')).toBe('2026-05-15 01:00');
    expect(formatDateMinute(ms, 'UTC')).toBe('2026-05-14 17:00');
  });

  it('default tz is UTC for back-compat', () => {
    expect(formatDateMinute(Date.UTC(2026, 3, 30, 12, 34, 56, 789))).toBe('2026-04-30 12:34');
  });
});

describe('formatTimeOfDay with tz', () => {
  it('returns HH:MM:SS in the given tz', () => {
    const ms = new Date('2026-05-14T17:30:45Z').getTime();
    expect(formatTimeOfDay(ms, 'Asia/Shanghai')).toBe('01:30:45');
    expect(formatTimeOfDay(ms, 'UTC')).toBe('17:30:45');
  });

  it('returns the raw input string and warns on garbage input', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(formatTimeOfDay(Number.NaN)).toBe('NaN');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('formatTimeOfDayMs', () => {
  it('appends 3-digit milliseconds in given tz', () => {
    const ms = new Date('2026-05-14T17:30:45.078Z').getTime();
    expect(formatTimeOfDayMs(ms, 'UTC')).toBe('17:30:45.078');
    expect(formatTimeOfDayMs(ms, 'Asia/Shanghai')).toBe('01:30:45.078');
  });

  it('falls back on bad input with a warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(formatTimeOfDayMs(Number.NaN)).toBe('NaN');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('todayLocal / yesterdayLocal / shiftLocalDate', () => {
  it('todayLocal returns current YMD in tz', () => {
    const today = todayLocal('UTC');
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('yesterdayLocal returns yesterday in tz', () => {
    const yesterday = yesterdayLocal('UTC');
    expect(yesterday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('shiftLocalDate adds days', () => {
    expect(shiftLocalDate('2026-05-14', -1)).toBe('2026-05-13');
    expect(shiftLocalDate('2026-05-14', 1)).toBe('2026-05-15');
  });

  it('shiftLocalDate crosses month/year boundaries', () => {
    expect(shiftLocalDate('2026-01-31', 1)).toBe('2026-02-01');
    expect(shiftLocalDate('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('shiftLocalDate does not slip across DST (EU DST start 2026-03-29)', () => {
    expect(shiftLocalDate('2026-03-29', 1)).toBe('2026-03-30');
  });

  it('todayLocal reflects tz at boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-30T01:00:00Z'));
    try {
      expect(todayLocal('UTC')).toBe('2026-04-30');
      // 2026-04-30T01:00:00Z = 2026-04-30 09:00 Asia/Shanghai
      expect(todayLocal('Asia/Shanghai')).toBe('2026-04-30');
      // 2026-04-30T01:00:00Z = 2026-04-29 21:00 America/New_York (UTC-4 EDT)
      expect(todayLocal('America/New_York')).toBe('2026-04-29');
    } finally {
      vi.useRealTimers();
    }
  });

  it('yesterdayLocal steps back by one calendar day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-30T01:00:00Z'));
    try {
      expect(yesterdayLocal('UTC')).toBe('2026-04-29');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('formatDateOnly / formatDateMinute back-compat (default UTC)', () => {
  it('formatDateMinute trims to YYYY-MM-DD HH:MM with space separator', () => {
    expect(formatDateMinute(Date.UTC(2026, 3, 30, 12, 34, 56, 789))).toBe('2026-04-30 12:34');
  });

  it('formatDateOnly trims to YYYY-MM-DD', () => {
    expect(formatDateOnly(Date.UTC(2026, 3, 30, 12, 34, 56))).toBe('2026-04-30');
  });
});

describe('formatLocalDateTimeInput', () => {
  it('returns empty string for null', () => {
    expect(formatLocalDateTimeInput(null, 'UTC')).toBe('');
  });

  it('returns empty string for invalid Date-range values', () => {
    expect(formatLocalDateTimeInput(Number.NaN, 'UTC')).toBe('');
    expect(formatLocalDateTimeInput(9_000_000_000_000_000, 'UTC')).toBe('');
  });

  it('formats unix ms to YYYY-MM-DDTHH:mm in UTC', () => {
    const ms = Date.UTC(2026, 4, 19, 14, 30, 0);
    expect(formatLocalDateTimeInput(ms, 'UTC')).toBe('2026-05-19T14:30');
  });

  it('respects IANA timezone offset', () => {
    const ms = Date.UTC(2026, 4, 19, 14, 30, 0);
    expect(formatLocalDateTimeInput(ms, 'Asia/Shanghai')).toBe('2026-05-19T22:30');
  });
});

describe('parseLocalDateTimeInput', () => {
  it('returns null for empty / whitespace', () => {
    expect(parseLocalDateTimeInput('', 'UTC')).toBeNull();
    expect(parseLocalDateTimeInput('   ', 'UTC')).toBeNull();
  });

  it('parses YYYY-MM-DDTHH:mm in UTC to correct unix ms', () => {
    expect(parseLocalDateTimeInput('2026-05-19T14:30', 'UTC')).toBe(
      Date.UTC(2026, 4, 19, 14, 30, 0),
    );
  });

  it('parses with IANA timezone offset', () => {
    expect(parseLocalDateTimeInput('2026-05-19T14:30', 'Asia/Shanghai')).toBe(
      Date.UTC(2026, 4, 19, 6, 30, 0),
    );
  });

  it('returns null for malformed input', () => {
    expect(parseLocalDateTimeInput('not-a-date', 'UTC')).toBeNull();
    expect(parseLocalDateTimeInput('2026-05-19', 'UTC')).toBeNull();
  });

  it('DST spring-forward gap: returns next valid wall-clock instant', () => {
    // 2026-03-08 02:30 America/New_York does not exist (jumps 02:00 → 03:00 EDT).
    // Policy 与 @goldpan/core/lib/tz.ts:epochMsForLocal 一致 — 接受 Intl 默认
    // 把不存在的墙钟映射到一小时后的 UTC 时刻 (= 03:30 EDT)。
    const ms = parseLocalDateTimeInput('2026-03-08T02:30', 'America/New_York');
    expect(ms).not.toBeNull();
    // Round-trip 应当落在 03:30 (next valid wall-clock):
    expect(formatLocalDateTimeInput(ms, 'America/New_York')).toBe('2026-03-08T03:30');
  });

  it('handles half-hour offset tz (Asia/Kolkata, UTC+5:30) correctly', () => {
    // 锁定非整数小时 offset 的 round-trip 行为，防止任何 ±N 小时启发式回归。
    const ms = parseLocalDateTimeInput('2026-05-19T14:30', 'Asia/Kolkata');
    expect(ms).toBe(Date.UTC(2026, 4, 19, 9, 0, 0));
    expect(formatLocalDateTimeInput(ms, 'Asia/Kolkata')).toBe('2026-05-19T14:30');
  });
});

describe('freqDescriptor', () => {
  it('60 -> hourly', () => {
    expect(freqDescriptor(60)).toEqual({ key: 'freq_hourly' });
  });

  it('1440 -> daily', () => {
    expect(freqDescriptor(1440)).toEqual({ key: 'freq_daily' });
  });

  it('10080 -> weekly', () => {
    expect(freqDescriptor(10080)).toEqual({ key: 'freq_weekly' });
  });

  it('sub-hour -> minutes with n', () => {
    expect(freqDescriptor(15)).toEqual({ key: 'freq_minutes', n: 15 });
  });

  it('exact hour multiple -> hours with n', () => {
    expect(freqDescriptor(180)).toEqual({ key: 'freq_hours', n: 3 });
  });

  it('non-multiple -> every_n_minutes', () => {
    expect(freqDescriptor(135)).toEqual({ key: 'every_n_minutes', n: 135 });
  });
});
