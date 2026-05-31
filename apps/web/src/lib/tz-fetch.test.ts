import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getEffectiveTimezone', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete process.env.GOLDPAN_TIMEZONE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns timezone from server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ timezone: 'Asia/Tokyo', language: 'en' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const { getEffectiveTimezone } = await import('./tz-fetch');
    expect(await getEffectiveTimezone()).toBe('Asia/Tokyo');
  });

  it('falls back to GOLDPAN_TIMEZONE env when server unreachable', async () => {
    process.env.GOLDPAN_TIMEZONE = 'America/New_York';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    const { getEffectiveTimezone } = await import('./tz-fetch');
    expect(await getEffectiveTimezone()).toBe('America/New_York');
  });

  it('falls back to UTC when env also unset', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    const { getEffectiveTimezone } = await import('./tz-fetch');
    expect(await getEffectiveTimezone()).toBe('UTC');
  });
});
