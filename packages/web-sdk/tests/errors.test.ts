// packages/web-sdk/tests/errors.test.ts
import { describe, expect, it } from 'vitest';
import { GoldpanApiError } from '../src/errors';

describe('GoldpanApiError', () => {
  it('extends Error', () => {
    const err = new GoldpanApiError('Not found', 'not_found', 404);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GoldpanApiError);
  });

  it('has correct name', () => {
    const err = new GoldpanApiError('fail', 'unknown', 500);
    expect(err.name).toBe('GoldpanApiError');
  });

  it('stores code and status', () => {
    const err = new GoldpanApiError('Rate limited', 'rate_limited', 429);
    expect(err.message).toBe('Rate limited');
    expect(err.code).toBe('rate_limited');
    expect(err.status).toBe(429);
  });

  it('has a stack trace', () => {
    const err = new GoldpanApiError('fail', 'test', 400);
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('GoldpanApiError');
  });
});
