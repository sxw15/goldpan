import { searchOutputSchema, validateContribution } from '@goldpan/core/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('tool-search-serper', () => {
  beforeEach(() => {
    vi.stubEnv('GOLDPAN_SERPER_SEARCH_ENABLED', 'true');
    vi.stubEnv('SERPER_API_KEY', 'test-serper-key');
    mockFetch.mockReset();
  });
  afterEach(async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.destroy?.();
    vi.unstubAllEnvs();
  });

  it('exports goldpanPlugin with correct metadata', async () => {
    const { goldpanPlugin } = await import('../src/index');
    expect(goldpanPlugin.name).toBe('tool-search-serper');
    expect(goldpanPlugin.type).toBe('tool');
    expect(goldpanPlugin.priority).toBe(15);
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
    expect(mockFetch.mock.calls.at(-1)?.[1].headers['X-API-KEY']).toBe('ok');
  });

  it('throws on executeTool when API key is missing (no restart needed to fix)', async () => {
    vi.stubEnv('SERPER_API_KEY', '');
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });
    await expect(goldpanPlugin.executeTool('search', { query: 'test' })).rejects.toThrow(
      /not configured/,
    );
  });

  it('throws on executeTool when enable toggle is off, even with API key set', async () => {
    vi.stubEnv('GOLDPAN_SERPER_SEARCH_ENABLED', 'false');
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });
    await expect(goldpanPlugin.executeTool('search', { query: 'test' })).rejects.toThrow(
      /disabled/,
    );
  });

  it('reads API key freshly per call so runtime updates take effect without restart', async () => {
    vi.stubEnv('SERPER_API_KEY', 'first-key');
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ organic: [] }) });

    await goldpanPlugin.executeTool('search', { query: 'q1' });
    expect(mockFetch.mock.calls[0][1].headers['X-API-KEY']).toBe('first-key');

    vi.stubEnv('SERPER_API_KEY', 'second-key');
    await goldpanPlugin.executeTool('search', { query: 'q2' });
    expect(mockFetch.mock.calls[1][1].headers['X-API-KEY']).toBe('second-key');
  });

  it('executeTool calls Serper API and returns mapped output', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        organic: [
          {
            title: 'Result 1',
            link: 'https://example.com/1',
            snippet: 'Snippet 1',
            date: '2 days ago',
          },
          { title: 'Result 2', link: 'https://example.com/2', snippet: 'Snippet 2' },
        ],
      }),
    });

    const result = await goldpanPlugin.executeTool('search', {
      query: 'test query',
      maxResults: 5,
    });

    const parsed = searchOutputSchema.parse(result);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0].url).toBe('https://example.com/1');
    expect(parsed.results[0].publishedAt).toBe('2 days ago');
    expect(parsed.results[1].publishedAt).toBeUndefined();
    expect(parsed.searchEngine).toBe('serper');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://google.serper.dev/search',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-API-KEY': 'test-serper-key' }),
      }),
    );
  });

  it('throws on API error', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests' });

    await expect(goldpanPlugin.executeTool('search', { query: 'test' })).rejects.toThrow(/429/);
  });
});
