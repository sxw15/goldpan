import { searchOutputSchema, validateContribution } from '@goldpan/core/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('tool-search-brave', () => {
  beforeEach(() => {
    vi.stubEnv('GOLDPAN_BRAVE_SEARCH_ENABLED', 'true');
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'test-key-123');
    mockFetch.mockReset();
  });
  afterEach(async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.destroy?.();
    vi.unstubAllEnvs();
  });

  it('exports goldpanPlugin with correct metadata', async () => {
    const { goldpanPlugin } = await import('../src/index');
    expect(goldpanPlugin.name).toBe('tool-search-brave');
    expect(goldpanPlugin.type).toBe('tool');
    expect(goldpanPlugin.priority).toBe(12);
  });

  it('registers tools statically (independent of env state)', async () => {
    const { goldpanPlugin } = await import('../src/index');
    expect(goldpanPlugin.tools).toHaveLength(1);
    expect(goldpanPlugin.tools[0].name).toBe('search');
  });

  it('declares a valid settings contribution with a test handler', async () => {
    const { goldpanPlugin } = await import('../src/index');
    expect(validateContribution(goldpanPlugin.settingsContribution).ok).toBe(true);
    expect(typeof goldpanPlugin.settingsActionHandlers?.test).toBe('function');
  });

  it('test action maps missing, auth, rate-limit and success outcomes', async () => {
    const { goldpanPlugin } = await import('../src/index');
    const test = goldpanPlugin.settingsActionHandlers?.test;
    expect(
      await test?.({
        values: { apiKey: '' },
        locale: 'en',
        logger: console as never,
        signal: new AbortController().signal,
      }),
    ).toEqual({ ok: false, code: 'no_api_key' });

    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    expect(
      await test?.({
        values: { apiKey: 'bad' },
        locale: 'en',
        logger: console as never,
        signal: new AbortController().signal,
      }),
    ).toEqual({ ok: false, code: 'unauthorized' });

    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 });
    expect(
      await test?.({
        values: { apiKey: 'limited' },
        locale: 'en',
        logger: console as never,
        signal: new AbortController().signal,
      }),
    ).toEqual({ ok: false, code: 'rate_limited' });

    mockFetch.mockResolvedValueOnce({ ok: true });
    expect(
      await test?.({
        values: { apiKey: 'ok' },
        locale: 'en',
        logger: console as never,
        signal: new AbortController().signal,
      }),
    ).toEqual({
      ok: true,
    });
    expect(mockFetch.mock.calls.at(-1)?.[1].headers['X-Subscription-Token']).toBe('ok');
  });

  it('throws on executeTool when API key is missing (no restart needed to fix)', async () => {
    vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });
    await expect(goldpanPlugin.executeTool('search', { query: 'test' })).rejects.toThrow(
      /not configured/,
    );
  });

  it('throws on executeTool when enable toggle is off, even with API key set', async () => {
    vi.stubEnv('GOLDPAN_BRAVE_SEARCH_ENABLED', 'false');
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });
    await expect(goldpanPlugin.executeTool('search', { query: 'test' })).rejects.toThrow(
      /disabled/,
    );
  });

  it('reads API key freshly per call so runtime updates take effect without restart', async () => {
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'first-key');
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ web: { results: [] } }) });

    await goldpanPlugin.executeTool('search', { query: 'q1' });
    expect(mockFetch.mock.calls[0][1].headers['X-Subscription-Token']).toBe('first-key');

    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'second-key');
    await goldpanPlugin.executeTool('search', { query: 'q2' });
    expect(mockFetch.mock.calls[1][1].headers['X-Subscription-Token']).toBe('second-key');
  });

  it('executeTool calls Brave API with correct headers and returns mapped output', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        web: {
          results: [
            {
              url: 'https://example.com',
              title: 'Example',
              description: 'A snippet',
              page_age: '2026-01-01T00:00:00Z',
            },
          ],
        },
      }),
    });

    const result = await goldpanPlugin.executeTool('search', {
      query: 'test',
      maxResults: 5,
    });

    const parsed = searchOutputSchema.parse(result);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].url).toBe('https://example.com');
    expect(parsed.results[0].snippet).toBe('A snippet');
    expect(parsed.searchEngine).toBe('brave');

    const [calledUrl, calledInit] = mockFetch.mock.calls[0];
    expect(calledUrl).toMatch(/^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?/);
    expect(calledUrl).toContain('q=test');
    expect(calledUrl).toContain('count=5');
    expect(calledInit.method).toBe('GET');
    expect(calledInit.headers).toMatchObject({ 'X-Subscription-Token': 'test-key-123' });
  });

  it('caps count at 20 and tolerates missing web.results', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const result = await goldpanPlugin.executeTool('search', {
      query: 'test',
      maxResults: 50,
    });
    expect(result.results).toHaveLength(0);
    expect(result.searchEngine).toBe('brave');
    expect(mockFetch.mock.calls[0][0]).toContain('count=20');
  });

  it('passes freshness when timeRange != any', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ web: { results: [] } }) });
    await goldpanPlugin.executeTool('search', { query: 'test', timeRange: 'week' });
    expect(mockFetch.mock.calls[0][0]).toContain('freshness=pw');
  });

  it('throws on API error', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests' });

    await expect(goldpanPlugin.executeTool('search', { query: 'test' })).rejects.toThrow(/429/);
  });
});
