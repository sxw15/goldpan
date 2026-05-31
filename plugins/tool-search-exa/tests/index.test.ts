import { searchOutputSchema, validateContribution } from '@goldpan/core/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('tool-search-exa', () => {
  beforeEach(() => {
    vi.stubEnv('GOLDPAN_EXA_SEARCH_ENABLED', 'true');
    vi.stubEnv('EXA_API_KEY', 'test-key-123');
    mockFetch.mockReset();
  });
  afterEach(async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.destroy?.();
    vi.unstubAllEnvs();
  });

  it('exports goldpanPlugin with correct metadata', async () => {
    const { goldpanPlugin } = await import('../src/index');
    expect(goldpanPlugin.name).toBe('tool-search-exa');
    expect(goldpanPlugin.type).toBe('tool');
    expect(goldpanPlugin.priority).toBe(18);
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
    expect(mockFetch.mock.calls.at(-1)?.[1].headers['x-api-key']).toBe('ok');
  });

  it('throws on executeTool when API key is missing (no restart needed to fix)', async () => {
    vi.stubEnv('EXA_API_KEY', '');
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });
    await expect(goldpanPlugin.executeTool('search', { query: 'test' })).rejects.toThrow(
      /not configured/,
    );
  });

  it('throws on executeTool when enable toggle is off, even with API key set', async () => {
    vi.stubEnv('GOLDPAN_EXA_SEARCH_ENABLED', 'false');
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });
    await expect(goldpanPlugin.executeTool('search', { query: 'test' })).rejects.toThrow(
      /disabled/,
    );
  });

  it('reads API key freshly per call so runtime updates take effect without restart', async () => {
    vi.stubEnv('EXA_API_KEY', 'first-key');
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });

    await goldpanPlugin.executeTool('search', { query: 'q1' });
    expect(mockFetch.mock.calls[0][1].headers['x-api-key']).toBe('first-key');

    vi.stubEnv('EXA_API_KEY', 'second-key');
    await goldpanPlugin.executeTool('search', { query: 'q2' });
    expect(mockFetch.mock.calls[1][1].headers['x-api-key']).toBe('second-key');
  });

  it('executeTool calls Exa API and returns mapped output', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          {
            url: 'https://example.com',
            title: 'Example',
            text: 'A snippet',
            publishedDate: '2026-01-01T00:00:00Z',
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
    expect(parsed.results[0].snippet).toBe('A snippet');
    expect(parsed.searchEngine).toBe('exa');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.exa.ai/search',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'test-key-123' }),
      }),
    );
  });

  it('falls back to url when title missing and tolerates missing text', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [{ url: 'https://no-title.example/abc', title: null }],
      }),
    });

    const result = await goldpanPlugin.executeTool('search', { query: 'test' });
    const parsed = searchOutputSchema.parse(result);
    expect(parsed.results[0].title).toBe('https://no-title.example/abc');
    expect(parsed.results[0].snippet).toBe('');
  });

  it('passes startPublishedDate when timeRange != any', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });

    await goldpanPlugin.executeTool('search', { query: 'test', timeRange: 'week' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(typeof body.startPublishedDate).toBe('string');
    expect(body.startPublishedDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('forwards includeDomains / excludeDomains as camelCase arrays', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    await goldpanPlugin.executeTool('search', {
      query: 'test',
      includeDomains: ['arxiv.org', '*.research.io'],
      excludeDomains: ['example.com'],
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.includeDomains).toEqual(['arxiv.org', '*.research.io']);
    expect(body.excludeDomains).toEqual(['example.com']);
  });

  it('omits include / exclude domains when empty', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    await goldpanPlugin.executeTool('search', {
      query: 'test',
      includeDomains: [],
      excludeDomains: [],
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('includeDomains');
    expect(body).not.toHaveProperty('excludeDomains');
  });

  it('forwards explicit startPublishedDate / endPublishedDate', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    await goldpanPlugin.executeTool('search', {
      query: 'test',
      startPublishedDate: '2024-01-01T00:00:00Z',
      endPublishedDate: '2024-03-31T23:59:59.999Z',
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.startPublishedDate).toBe('2024-01-01T00:00:00Z');
    expect(body.endPublishedDate).toBe('2024-03-31T23:59:59.999Z');
  });

  it('explicit startPublishedDate overrides the value derived from timeRange', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    await goldpanPlugin.executeTool('search', {
      query: 'test',
      timeRange: 'week',
      startPublishedDate: '2020-05-01T00:00:00Z',
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.startPublishedDate).toBe('2020-05-01T00:00:00Z');
  });

  it('rejects non-ISO startPublishedDate (date-only YYYY-MM-DD is not enough)', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    await expect(
      goldpanPlugin.executeTool('search', {
        query: 'test',
        startPublishedDate: '2024-01-01',
      }),
    ).rejects.toThrow();
  });

  it('rejects includeDomains exceeding 1200 entries', async () => {
    const { goldpanPlugin } = await import('../src/index');
    await goldpanPlugin.initialize?.({ logger: console as any, pluginConfig: {} });

    const tooMany = Array.from({ length: 1201 }, (_, i) => `d${i}.com`);
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
