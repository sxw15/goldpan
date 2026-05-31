import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GithubApiClient } from '../src/api.js';

const originalFetch = globalThis.fetch;

function mockResponse(init: { status: number; headers?: Record<string, string>; body?: unknown }) {
  return new Response(init.body === undefined ? null : JSON.stringify(init.body), {
    status: init.status,
    headers: init.headers,
  });
}

describe('GithubApiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: GithubApiClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    client = new GithubApiClient({
      token: undefined,
      apiBase: 'https://api.github.com',
      timeoutMs: 1_000,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns 304 without body when If-None-Match matches', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 304, headers: {} }));
    const result = await client.getRepo({ owner: 'o', repo: 'r', etag: 'W/"abc"' });
    expect(result.status).toBe(304);
  });

  it('throws terminal NOT_FOUND on 404', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 404, body: { message: 'Not Found' } }));
    await expect(client.getRepo({ owner: 'o', repo: 'r' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      terminal: true,
    });
  });

  it('throws terminal RATE_LIMIT on 403 with X-RateLimit-Remaining: 0', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': `${Math.floor(Date.now() / 1000) + 60}`,
        },
        body: { message: 'API rate limit exceeded' },
      }),
    );
    await expect(client.getRepo({ owner: 'o', repo: 'r' })).rejects.toMatchObject({
      code: 'RATE_LIMIT',
      terminal: true,
    });
  });

  it('retries 500 three times before throwing non-terminal UPSTREAM', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 500, body: { message: 'oops' } }))
      .mockResolvedValueOnce(mockResponse({ status: 500, body: { message: 'oops' } }))
      .mockResolvedValueOnce(mockResponse({ status: 500, body: { message: 'oops' } }));
    await expect(client.getRepo({ owner: 'o', repo: 'r' })).rejects.toMatchObject({
      code: 'UPSTREAM',
      terminal: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns 200 body + etag on success', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        headers: { etag: 'W/"xyz"' },
        body: { full_name: 'o/r' },
      }),
    );
    const result = await client.getRepo({ owner: 'o', repo: 'r' });
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.etag).toBe('W/"xyz"');
      expect(result.body).toEqual({ full_name: 'o/r' });
    }
  });

  it('sets Authorization header when token provided', async () => {
    const withToken = new GithubApiClient({
      token: 'pat_abc',
      apiBase: 'https://api.github.com',
      timeoutMs: 1000,
    });
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 200, body: {} }));
    await withToken.getRepo({ owner: 'o', repo: 'r' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBe('Bearer pat_abc');
  });

  it('omits Authorization header when token absent', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 200, body: {} }));
    await client.getRepo({ owner: 'o', repo: 'r' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
