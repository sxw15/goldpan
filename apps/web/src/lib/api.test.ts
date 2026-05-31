import { GoldpanApiError } from '@goldpan/web-sdk';
import { describe, expect, it } from 'vitest';
import { isPluginDisabled, parsePositiveIntField, pickApiErrorKey } from './api';

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

describe('parsePositiveIntField', () => {
  it('parses a positive integer', () => {
    expect(parsePositiveIntField(fd({ id: '7' }), 'id')).toBe(7);
  });

  it('rejects zero', () => {
    expect(parsePositiveIntField(fd({ id: '0' }), 'id')).toBeNull();
  });

  it('rejects negative', () => {
    expect(parsePositiveIntField(fd({ id: '-1' }), 'id')).toBeNull();
  });

  it('rejects fractional', () => {
    expect(parsePositiveIntField(fd({ id: '1.5' }), 'id')).toBeNull();
  });

  it('rejects non-numeric', () => {
    expect(parsePositiveIntField(fd({ id: 'abc' }), 'id')).toBeNull();
  });

  it('rejects missing', () => {
    expect(parsePositiveIntField(fd({}), 'id')).toBeNull();
  });
});

describe('isPluginDisabled', () => {
  it('matches 503 + plugin_disabled', () => {
    expect(isPluginDisabled(new GoldpanApiError('m', 'plugin_disabled', 503))).toBe(true);
  });

  it('rejects wrong status', () => {
    expect(isPluginDisabled(new GoldpanApiError('m', 'plugin_disabled', 500))).toBe(false);
  });

  it('rejects wrong code', () => {
    expect(isPluginDisabled(new GoldpanApiError('m', 'not_found', 503))).toBe(false);
  });

  it('rejects non-GoldpanApiError', () => {
    expect(isPluginDisabled(new Error('plain'))).toBe(false);
    expect(isPluginDisabled(null)).toBe(false);
    expect(isPluginDisabled('string')).toBe(false);
  });
});

describe('pickApiErrorKey', () => {
  const matchers = [
    { status: 404, key: 'not_found' },
    { code: 'invalid_status', key: 'wrong_status' },
    { status: 500, code: 'server_error', key: 'srv' },
  ] as const;

  it('returns null for non-GoldpanApiError', () => {
    expect(pickApiErrorKey(new Error('x'), matchers)).toBeNull();
    expect(pickApiErrorKey(null, matchers)).toBeNull();
    expect(pickApiErrorKey('string', matchers)).toBeNull();
  });

  it('matches by status only', () => {
    expect(pickApiErrorKey(new GoldpanApiError('m', 'whatever', 404), matchers)).toBe('not_found');
  });

  it('matches by code only', () => {
    expect(pickApiErrorKey(new GoldpanApiError('m', 'invalid_status', 422), matchers)).toBe(
      'wrong_status',
    );
  });

  it('matches by status + code combined', () => {
    expect(pickApiErrorKey(new GoldpanApiError('m', 'server_error', 500), matchers)).toBe('srv');
  });

  it('returns the first match when multiple could apply', () => {
    // 404 matches the first matcher even though `code` also matches the second
    // when paired with a 422 — but here we use 404 + invalid_status, and the
    // 404 matcher should win because it's listed first.
    expect(pickApiErrorKey(new GoldpanApiError('m', 'invalid_status', 404), matchers)).toBe(
      'not_found',
    );
  });

  it('returns null when nothing matches', () => {
    expect(pickApiErrorKey(new GoldpanApiError('m', 'unknown', 418), matchers)).toBeNull();
  });

  it('preserves the literal key type via generics', () => {
    // Compile-time guarantee — if K narrowed to `string`, this would still
    // pass at runtime, but the explicit annotation here would error in tsc.
    const result: 'not_found' | 'wrong_status' | 'srv' | null = pickApiErrorKey(
      new GoldpanApiError('m', 'unknown', 404),
      matchers,
    );
    expect(result).toBe('not_found');
  });
});
