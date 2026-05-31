import { describe, expect, it } from 'vitest';
import { dateToMs, utcNowMs } from '../../src/db/timestamp.js';

describe('utcNowMs', () => {
  it('returns the current epoch milliseconds', () => {
    const before = Date.now();
    const v = utcNowMs();
    const after = Date.now();
    expect(v).toBeGreaterThanOrEqual(before);
    expect(v).toBeLessThanOrEqual(after);
  });
});

describe('dateToMs', () => {
  it('matches Date.prototype.getTime()', () => {
    const d = new Date('2026-04-30T12:34:56.789Z');
    expect(dateToMs(d)).toBe(d.getTime());
  });
});
