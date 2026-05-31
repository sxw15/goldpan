import { searchOutputSchema, validateContribution } from '@goldpan/core/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('tool-search-tavily', () => {
  beforeEach(() => {
    vi.stubEnv('GOLDPAN_TAVILY_SEARCH_ENABLED', 'true');
    vi.stubEnv('TAVILY_API_KEY', 'test-key-123');
    mockFetch.mockReset();
  });
  afterEach(async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.destroy?.();
    vi.unstubAllEnvs();
  });

  it('exports goldpanPlugin with correct metadata', async () => {
    const { goldpanPlugin } = await import('../src/index');
    expect(goldpanPlugin.name).toBe('tool-search-tavily');
    expect(goldpanPlugin.type).toBe('tool');
    expect(goldpanPlugin.priority).toBe(20);
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

    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
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
    expect(JSON.parse(mockFetch.mock.calls.at(-1)?.[1].body).api_key).toBe('ok');
  });

  it('throws on executeTool when API key is missing (no restart needed to fix)', async () => {
    vi.stubEnv('TAVILY_API_KEY', '');
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });
    await expect(goldpanPlugin.executeTool('search', { query: 'test' })).rejects.toThrow(
      /not configured/,
    );
  });

  it('throws on executeTool when enable toggle is off, even with API key set', async () => {
    vi.stubEnv('GOLDPAN_TAVILY_SEARCH_ENABLED', 'false');
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });
    await expect(goldpanPlugin.executeTool('search', { query: 'test' })).rejects.toThrow(
      /disabled/,
    );
  });

  it('reads API key freshly per call so runtime updates take effect without restart', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'first-key');
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });

    await goldpanPlugin.executeTool('search', { query: 'q1' });
    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(firstBody.api_key).toBe('first-key');

    vi.stubEnv('TAVILY_API_KEY', 'second-key');
    await goldpanPlugin.executeTool('search', { query: 'q2' });
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(secondBody.api_key).toBe('second-key');
  });

  it('executeTool calls Tavily API and returns mapped output', async () => {
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
            published_date: '2026-01-01',
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
    expect(parsed.results[0].url).toBe('https://example.com');
    expect(parsed.searchEngine).toBe('tavily');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.tavily.com/search',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('passes timeRange as full string (Tavily expects day/week/month, not d/w/m)', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    await goldpanPlugin.executeTool('search', { query: 'test', timeRange: 'week' });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.time_range).toBe('week');
  });

  it('omits time_range when timeRange === any (default)', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    await goldpanPlugin.executeTool('search', { query: 'test' });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('time_range');
  });

  it('forwards includeDomains / excludeDomains as snake_case arrays', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    await goldpanPlugin.executeTool('search', {
      query: 'test',
      includeDomains: ['reuters.com', 'wsj.com'],
      excludeDomains: ['reddit.com'],
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.include_domains).toEqual(['reuters.com', 'wsj.com']);
    expect(body.exclude_domains).toEqual(['reddit.com']);
  });

  it('omits include_domains / exclude_domains when not provided or empty', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    await goldpanPlugin.executeTool('search', {
      query: 'test',
      includeDomains: [],
      excludeDomains: [],
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('include_domains');
    expect(body).not.toHaveProperty('exclude_domains');
  });

  it('forwards startDate / endDate as snake_case', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    await goldpanPlugin.executeTool('search', {
      query: 'test',
      startDate: '2024-01-01',
      endDate: '2024-03-31',
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.start_date).toBe('2024-01-01');
    expect(body.end_date).toBe('2024-03-31');
  });

  it('rejects malformed startDate / endDate', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    await expect(
      goldpanPlugin.executeTool('search', { query: 'test', startDate: '01/01/2024' }),
    ).rejects.toThrow();
  });

  it('rejects includeDomains exceeding 150 entries', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    const tooMany = Array.from({ length: 151 }, (_, i) => `d${i}.com`);
    await expect(
      goldpanPlugin.executeTool('search', { query: 'test', includeDomains: tooMany }),
    ).rejects.toThrow();
  });

  it('throws on API error', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests' });

    await expect(goldpanPlugin.executeTool('search', { query: 'test' })).rejects.toThrow(/429/);
  });
});
