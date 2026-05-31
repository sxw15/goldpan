import { validateContribution } from '@goldpan/core/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goldpanPlugin } from '../src/index';

describe('github-collector settingsContribution', () => {
  it('declares a valid contribution', () => {
    const c = goldpanPlugin.settingsContribution;
    if (c === undefined) throw new Error('no contribution');
    const result = validateContribution(c);
    if (!result.ok) {
      throw new Error(`invalid: ${JSON.stringify(result.errors)}`);
    }
  });

  it('exposes only GOLDPAN_GITHUB_TOKEN (advanced envs stay hidden)', () => {
    const c = goldpanPlugin.settingsContribution;
    if (c === undefined) throw new Error('no contribution');
    const envKeys = c.fields.map((f) => f.envKey);
    expect(envKeys).toEqual(['GOLDPAN_GITHUB_TOKEN']);
  });

  it('includes a setupGuide with at least 2 steps', () => {
    const c = goldpanPlugin.settingsContribution;
    if (c === undefined) throw new Error('no contribution');
    expect(c.setupGuide?.steps.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('test action exists and is keyed by GOLDPAN_GITHUB_TOKEN', () => {
    const c = goldpanPlugin.settingsContribution;
    if (c === undefined) throw new Error('no contribution');
    const test = c.actions?.find((a) => a.kind === 'test');
    expect(test).toBeDefined();
    expect(test?.requires).toContain('token');
  });

  it('omits branding.homepage until a canonical public URL is decided', () => {
    // A previous draft pointed at `anthropics/goldpan` (404 for everyone)
    // and the canonical media-sun URL is a private repo (404 for non-members),
    // so the safest UX is to ship without a homepage link rather than render
    // a broken external link in the plugin meta strip.
    const c = goldpanPlugin.settingsContribution;
    if (c === undefined) throw new Error('no contribution');
    expect(c.branding.homepage).toBeUndefined();
  });

  it('setupGuide steps omit `images` until real screenshots ship', () => {
    // Placeholder `.txt` files were referenced as `<Image>` sources, which
    // would 404 (no real asset on disk under the loader-expected `static/`
    // dir) and even if served would not be valid images. Keep `images` off
    // until Phase 1.5 swaps in real PNG/WebP screenshots.
    const c = goldpanPlugin.settingsContribution;
    if (c === undefined) throw new Error('no contribution');
    for (const step of c.setupGuide?.steps ?? []) {
      expect(step.images).toBeUndefined();
    }
  });
});

describe('github-collector test action', () => {
  const handler = goldpanPlugin.settingsActionHandlers?.test;
  if (handler === undefined) throw new Error('test action handler missing');

  const fetchSpy = vi.fn();
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  function makeCtx(values: Record<string, string>) {
    return {
      values,
      locale: 'en' as const,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      } as never,
      signal: new AbortController().signal,
    };
  }

  it('hits the configured GOLDPAN_GITHUB_API_BASE for GitHub Enterprise installs', async () => {
    vi.stubEnv('GOLDPAN_GITHUB_API_BASE', 'https://ghe.example.com/api/v3');
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
    const result = await handler(makeCtx({ token: 'ghp_x' }));
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://ghe.example.com/api/v3/user');
  });

  it('falls back to https://api.github.com when GOLDPAN_GITHUB_API_BASE is unset', async () => {
    vi.stubEnv('GOLDPAN_GITHUB_API_BASE', '');
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
    const result = await handler(makeCtx({ token: 'ghp_x' }));
    expect(result.ok).toBe(true);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.github.com/user');
  });

  it('strips trailing slash on the configured api base', async () => {
    vi.stubEnv('GOLDPAN_GITHUB_API_BASE', 'https://ghe.example.com/api/v3/');
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
    await handler(makeCtx({ token: 'ghp_x' }));
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://ghe.example.com/api/v3/user');
  });

  it('returns no_token when no token is supplied (no fetch)', async () => {
    const result = await handler(makeCtx({ token: '' }));
    expect(result).toEqual({ ok: false, code: 'no_token' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
