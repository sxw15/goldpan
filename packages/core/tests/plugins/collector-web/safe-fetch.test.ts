import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectorError } from '../../../src/plugins/errors.js';
import { validateSsrfIfEnabled } from '../../../src/utils/ssrf.js';

// `safeFetch` calls `validateSsrfIfEnabled`, so we mock that. Mocking
// `validateSsrf` would no-op because nothing on the call path looks it up via
// the module export — the wrapper resolves `validateSsrf` internally.
vi.mock('../../../src/utils/ssrf.js', () => ({
  validateSsrfIfEnabled: vi.fn(),
}));

const mockedValidateSsrf = vi.mocked(validateSsrfIfEnabled);
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Dynamic import so the module picks up the mocked fetch / SSRF wrapper.
async function importSafeFetch() {
  const mod = await import('../../../src/plugins/builtin/collector-web/safe-fetch.js');
  return mod.safeFetch;
}

const ON = { ssrfValidationEnabled: true } as const;

describe('safeFetch', () => {
  let safeFetch: Awaited<ReturnType<typeof importSafeFetch>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockedValidateSsrf.mockResolvedValue(undefined);
    safeFetch = await importSafeFetch();
  });

  it('returns response and finalUrl for 200 OK', async () => {
    mockFetch.mockResolvedValueOnce(new Response('<html>hello</html>', { status: 200 }));

    const result = await safeFetch('https://example.com/article', undefined, ON);

    expect(result.response.status).toBe(200);
    expect(result.finalUrl).toBe('https://example.com/article');
    expect(mockedValidateSsrf).toHaveBeenCalledWith('https://example.com/article', true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/article',
      expect.objectContaining({
        redirect: 'manual',
      }),
    );
  });

  it('validates SSRF on initial URL', async () => {
    mockedValidateSsrf.mockRejectedValueOnce(new Error('SSRF: private IP address'));

    await expect(safeFetch('http://192.168.1.1/secret', undefined, ON)).rejects.toThrow(
      'SSRF: private IP',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('follows redirect chain and validates SSRF per hop with the flag forwarded', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { location: 'https://example.com/page2' } }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://example.com/page3' } }),
      )
      .mockResolvedValueOnce(new Response('<html>OK</html>', { status: 200 }));

    const result = await safeFetch('https://example.com/page1', undefined, ON);

    expect(result.response.status).toBe(200);
    expect(result.finalUrl).toBe('https://example.com/page3');
    // Pin the per-hop semantic: each hop reaches the SSRF wrapper with the
    // flag value forwarded — protects against a regression where safeFetch
    // forgets to pass `ssrfValidationEnabled` after the first iteration.
    expect(mockedValidateSsrf).toHaveBeenNthCalledWith(1, 'https://example.com/page1', true);
    expect(mockedValidateSsrf).toHaveBeenNthCalledWith(2, 'https://example.com/page2', true);
    expect(mockedValidateSsrf).toHaveBeenNthCalledWith(3, 'https://example.com/page3', true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('forwards ssrfValidationEnabled=false to every hop', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://example.com/dest' } }),
      )
      .mockResolvedValueOnce(new Response('OK', { status: 200 }));

    await safeFetch('https://example.com/src', undefined, { ssrfValidationEnabled: false });

    expect(mockedValidateSsrf).toHaveBeenNthCalledWith(1, 'https://example.com/src', false);
    expect(mockedValidateSsrf).toHaveBeenNthCalledWith(2, 'https://example.com/dest', false);
  });

  it('resolves relative redirect URLs', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: '/new-path' } }),
      )
      .mockResolvedValueOnce(new Response('<html>OK</html>', { status: 200 }));

    const result = await safeFetch('https://example.com/old-path', undefined, ON);

    expect(result.finalUrl).toBe('https://example.com/new-path');
  });

  it('handles all redirect status codes (301, 302, 303, 307, 308)', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      vi.clearAllMocks();
      mockedValidateSsrf.mockResolvedValue(undefined);
      mockFetch
        .mockResolvedValueOnce(
          new Response(null, { status, headers: { location: 'https://example.com/dest' } }),
        )
        .mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const result = await safeFetch('https://example.com/src', undefined, ON);
      expect(result.finalUrl).toBe('https://example.com/dest');
    }
  });

  it('throws CollectorError on too many redirects (retryable)', async () => {
    for (let i = 0; i < 6; i++) {
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: `https://example.com/r${i + 1}` },
        }),
      );
    }

    try {
      await safeFetch('https://example.com/start', undefined, ON);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CollectorError);
      expect((error as CollectorError).code).toBe('FETCH_FAILED');
      expect((error as CollectorError).retryable).toBe(true);
      expect((error as CollectorError).message).toBe('Too many redirects');
    }
  });

  it('throws on redirect without Location header (not retryable)', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 301 }));

    try {
      await safeFetch('https://example.com/bad', undefined, ON);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CollectorError);
      expect((error as CollectorError).code).toBe('FETCH_FAILED');
      expect((error as CollectorError).retryable).toBe(false);
      expect((error as CollectorError).message).toContain('Location');
    }
  });

  it('throws on redirect to non-HTTP protocol (not retryable)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'ftp://files.example.com/data' } }),
    );

    try {
      await safeFetch('https://example.com/redirect', undefined, ON);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CollectorError);
      expect((error as CollectorError).code).toBe('FETCH_FAILED');
      expect((error as CollectorError).retryable).toBe(false);
      expect((error as CollectorError).message).toContain('non-HTTP');
    }
  });

  it('throws on unexpected 3xx status (e.g. 304 Not Modified)', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 304 }));

    try {
      await safeFetch('https://example.com/cached', undefined, ON);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CollectorError);
      expect((error as CollectorError).code).toBe('FETCH_FAILED');
      expect((error as CollectorError).message).toContain('304');
    }
  });

  it('rejects redirect target that fails SSRF validation', async () => {
    mockedValidateSsrf
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('SSRF: private IP address'));

    mockFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 301,
        headers: { location: 'http://10.0.0.1/internal' },
      }),
    );

    await expect(safeFetch('https://evil.com/redirect', undefined, ON)).rejects.toThrow(
      'SSRF: private IP',
    );
  });

  it('passes AbortSignal to fetch', async () => {
    const controller = new AbortController();
    mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));

    await safeFetch('https://example.com', controller.signal, ON);

    expect(mockFetch).toHaveBeenCalledWith('https://example.com', {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Goldpan/1.0; +https://github.com/user/goldpan)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      },
    });
  });

  it('propagates AbortError from fetch', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'));

    await expect(safeFetch('https://example.com', undefined, ON)).rejects.toThrow('aborted');
  });

  it('returns 4xx/5xx responses without throwing (caller decides)', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const result = await safeFetch('https://example.com/missing', undefined, ON);
    expect(result.response.status).toBe(404);
    expect(result.finalUrl).toBe('https://example.com/missing');
  });
});
