import { buildContributionEnvSchema, searchOutputSchema } from '@goldpan/core/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('tool-search-searxng', () => {
  beforeEach(() => {
    vi.stubEnv('GOLDPAN_SEARXNG_SEARCH_ENABLED', 'true');
    vi.stubEnv('SEARXNG_BASE_URL', 'https://searx.example.com');
    mockFetch.mockReset();
  });
  afterEach(async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.destroy?.();
    vi.unstubAllEnvs();
  });

  it('exports goldpanPlugin with correct metadata', async () => {
    const { goldpanPlugin } = await import('../src/index');
    expect(goldpanPlugin.name).toBe('tool-search-searxng');
    expect(goldpanPlugin.type).toBe('tool');
    expect(goldpanPlugin.priority).toBe(8);
  });

  it('registers tools statically (independent of env state)', async () => {
    const { goldpanPlugin } = await import('../src/index');
    expect(goldpanPlugin.tools).toHaveLength(1);
    expect(goldpanPlugin.tools[0].name).toBe('search');
  });

  it('rejects invalid base URLs in its settings contribution schema', async () => {
    const { goldpanPlugin } = await import('../src/index');
    const schema = goldpanPlugin.settingsContribution?.schema;
    expect(schema?.safeParse({ baseUrl: 'https://searx.example.com' }).success).toBe(true);
    expect(schema?.safeParse({ baseUrl: '' }).success).toBe(true);
    expect(schema?.safeParse({ baseUrl: 'not a url' }).success).toBe(false);
    expect(schema?.safeParse({ baseUrl: 'ftp://searx.example.com' }).success).toBe(false);
    expect(schema?.safeParse({ baseUrl: 'https://searx.example.com/search?q=x' }).success).toBe(
      false,
    );
  });

  it('allows empty base URL in env validation so unrelated settings saves are not blocked', async () => {
    const { goldpanPlugin } = await import('../src/index');
    const envSchema = z.object(buildContributionEnvSchema(goldpanPlugin.settingsContribution!));
    expect(envSchema.safeParse({ SEARXNG_BASE_URL: '' }).success).toBe(true);
  });

  it('test action reports no_base_url for an empty base URL', async () => {
    const { goldpanPlugin } = await import('../src/index');
    const result = await goldpanPlugin.settingsActionHandlers?.test?.({
      values: { baseUrl: '' },
      locale: 'en',
      logger: console as never,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ ok: false, code: 'no_base_url' });
  });

  it('test action maps success, bad response and network outcomes', async () => {
    const { goldpanPlugin } = await import('../src/index');
    const test = goldpanPlugin.settingsActionHandlers?.test;

    mockFetch.mockResolvedValueOnce({ ok: true });
    expect(
      await test?.({
        values: { baseUrl: 'https://searx.example.com/' },
        locale: 'en',
        logger: console as never,
        signal: new AbortController().signal,
      }),
    ).toEqual({ ok: true });
    expect(mockFetch.mock.calls[0][0]).toBe('https://searx.example.com/search?q=ping&format=json');

    mockFetch.mockResolvedValueOnce({ ok: false });
    expect(
      await test?.({
        values: { baseUrl: 'https://searx.example.com' },
        locale: 'en',
        logger: console as never,
        signal: new AbortController().signal,
      }),
    ).toEqual({ ok: false, code: 'bad_response' });

    mockFetch.mockRejectedValueOnce(new Error('offline'));
    expect(
      await test?.({
        values: { baseUrl: 'https://searx.example.com' },
        locale: 'en',
        logger: console as never,
        signal: new AbortController().signal,
      }),
    ).toEqual({ ok: false, code: 'network_error' });
  });

  it('throws on executeTool when base URL is missing (no restart needed to fix)', async () => {
    vi.stubEnv('SEARXNG_BASE_URL', '');
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });
    await expect(goldpanPlugin.executeTool('search', { query: 'test' })).rejects.toThrow(
      /not configured/,
    );
  });

  it('throws on executeTool when enable toggle is off, even with base URL set', async () => {
    vi.stubEnv('GOLDPAN_SEARXNG_SEARCH_ENABLED', 'false');
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });
    await expect(goldpanPlugin.executeTool('search', { query: 'test' })).rejects.toThrow(
      /disabled/,
    );
  });

  it('reads base URL freshly per call so runtime updates take effect without restart', async () => {
    vi.stubEnv('SEARXNG_BASE_URL', 'https://first.example.com');
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });

    await goldpanPlugin.executeTool('search', { query: 'q1' });
    expect(mockFetch.mock.calls[0][0]).toMatch(/^https:\/\/first\.example\.com\/search\?/);

    vi.stubEnv('SEARXNG_BASE_URL', 'https://second.example.com');
    await goldpanPlugin.executeTool('search', { query: 'q2' });
    expect(mockFetch.mock.calls[1][0]).toMatch(/^https:\/\/second\.example\.com\/search\?/);
  });

  it('strips trailing slash on base URL', async () => {
    vi.stubEnv('SEARXNG_BASE_URL', 'https://searx.example.com/');
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    await goldpanPlugin.executeTool('search', { query: 'test' });
    expect(mockFetch.mock.calls[0][0]).toMatch(/^https:\/\/searx\.example\.com\/search\?/);
  });

  it('executeTool calls SearXNG and returns mapped output', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          {
            url: 'https://example.com',
            title: 'Example',
            content: 'A snippet',
            publishedDate: '2026-01-01',
          },
        ],
      }),
    });

    const result = await goldpanPlugin.executeTool('search', {
      query: 'test',
      maxResults: 5,
    });

    const parsed = searchOutputSchema.parse(result);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].snippet).toBe('A snippet');
    expect(parsed.searchEngine).toBe('searxng');

    const [calledUrl, calledInit] = mockFetch.mock.calls[0];
    expect(calledUrl).toContain('q=test');
    expect(calledUrl).toContain('format=json');
    expect(calledInit.method).toBe('GET');
  });

  it('client-side trims results to maxResults', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: Array.from({ length: 15 }, (_, i) => ({
          url: `https://example.com/${i}`,
          title: `t${i}`,
          content: 's',
        })),
      }),
    });

    const result = await goldpanPlugin.executeTool('search', { query: 'test', maxResults: 3 });
    expect(result.results).toHaveLength(3);
  });

  it('passes time_range when timeRange != any', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    await goldpanPlugin.executeTool('search', { query: 'test', timeRange: 'month' });
    expect(mockFetch.mock.calls[0][0]).toContain('time_range=month');
  });

  it('throws on API error', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' });

    await expect(goldpanPlugin.executeTool('search', { query: 'test' })).rejects.toThrow(/503/);
  });
});
