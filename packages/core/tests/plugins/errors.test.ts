import { describe, expect, it } from 'vitest';
import { CollectorError } from '../../src/plugins/errors.js';

describe('CollectorError', () => {
  it('defaults terminal to false for backward compatibility', () => {
    const err = new CollectorError('boom', 'FETCH_FAILED', true);
    expect(err.terminal).toBe(false);
    expect(err.retryable).toBe(true);
    expect(err.code).toBe('FETCH_FAILED');
  });

  it('accepts terminal as fifth positional arg', () => {
    const err = new CollectorError('gone', 'NOT_FOUND', false, undefined, true);
    expect(err.terminal).toBe(true);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('exposes new GitHub-oriented error codes', () => {
    const codes = ['NOT_FOUND', 'RATE_LIMIT', 'INVALID_REQUEST', 'UPSTREAM'] as const;
    for (const code of codes) {
      const err = new CollectorError('m', code, false, undefined, true);
      expect(err.code).toBe(code);
    }
  });
});
