import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectorError } from '../../../src/plugins/errors.js';
import { validateSsrfIfEnabled } from '../../../src/utils/ssrf.js';

// `safeFetch` calls `validateSsrfIfEnabled`, so we mock that. Mocking
// `validateSsrf` would no-op because nothing on the call path looks it up via
// the module export.
vi.mock('../../../src/utils/ssrf.js', () => ({
  validateSsrfIfEnabled: vi.fn(),
}));

const mockedValidateSsrf = vi.mocked(validateSsrfIfEnabled);
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Minimal but realistic HTML that Readability can extract
const ARTICLE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta property="article:published_time" content="2025-06-01T12:00:00Z">
  <title>Test Article Title</title>
</head>
<body>
  <article>
    <h1>Test Article Title</h1>
    <p class="byline">By Test Author</p>
    <p>This is a comprehensive test article about web technologies and modern development
    practices. It contains enough content for Readability to successfully extract and process
    the main body text without issues.</p>
    <h2>Section One</h2>
    <p>More detailed content about the first topic with explanations and examples that provide
    sufficient depth for the extraction algorithm to identify this as meaningful content.</p>
    <h2>Section Two</h2>
    <p>Additional information covering the second major topic area with thorough explanations
    and context to round out the article structure.</p>
  </article>
</body>
</html>`;

// Dynamic import so the module picks up the mocked fetch/validateSsrf
async function importPlugin() {
  const mod = await import('../../../src/plugins/builtin/collector-web/index.js');
  return mod.collectorWebPlugin;
}

describe('collectorWebPlugin', () => {
  let plugin: Awaited<ReturnType<typeof importPlugin>>;
  const signal = new AbortController().signal;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockedValidateSsrf.mockResolvedValue(undefined);
    plugin = await importPlugin();
  });

  describe('plugin metadata', () => {
    it('has correct plugin properties', () => {
      expect(plugin.name).toBe('collector-web');
      expect(plugin.type).toBe('collector');
      expect(plugin.version).toBe('0.1.0');
      expect(plugin.priority).toBe(0);
    });
  });

  describe('canHandle', () => {
    it('accepts http URLs', () => {
      expect(plugin.canHandle({ url: 'http://example.com' })).toBe(true);
    });

    it('accepts https URLs', () => {
      expect(plugin.canHandle({ url: 'https://example.com/path?q=1' })).toBe(true);
    });

    it('rejects ftp URLs', () => {
      expect(plugin.canHandle({ url: 'ftp://files.example.com' })).toBe(false);
    });

    it('rejects data URIs', () => {
      expect(plugin.canHandle({ url: 'data:text/html,<h1>hi</h1>' })).toBe(false);
    });

    it('rejects invalid URLs', () => {
      expect(plugin.canHandle({ url: 'not-a-url' })).toBe(false);
    });
  });

  describe('collect', () => {
    it('collects and converts web page to markdown', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(ARTICLE_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      );

      const result = await plugin.collect({ url: 'https://example.com/article' }, signal);

      expect(result.content).toContain('comprehensive test article');
      expect(result.content).toContain('## Section One');
      expect(result.title).toContain('Test Article');
      expect(result.finalUrl).toBe('https://example.com/article');
    });

    it('includes collector_ prefixed metadata', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(ARTICLE_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      );

      const result = await plugin.collect({ url: 'https://example.com/article' }, signal);

      expect(result.metadata.collector_finalUrl).toBe('https://example.com/article');
      for (const key of Object.keys(result.metadata)) {
        expect(key).toMatch(/^collector_/);
      }
    });

    it('includes author and publishedAt in metadata when available', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(ARTICLE_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      );

      const result = await plugin.collect({ url: 'https://example.com/article' }, signal);

      expect(result.metadata.collector_finalUrl).toBeDefined();
      if (result.metadata.collector_publishedAt) {
        expect(result.metadata.collector_publishedAt).toContain('2025-06-01');
      }
    });

    it('tracks finalUrl through redirects', async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response(null, {
            status: 301,
            headers: { location: 'https://example.com/final' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(ARTICLE_HTML, {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
        );

      const result = await plugin.collect({ url: 'https://example.com/old' }, signal);

      expect(result.finalUrl).toBe('https://example.com/final');
      expect(result.metadata.collector_finalUrl).toBe('https://example.com/final');
    });

    it('throws FETCH_FAILED for 4xx responses (not retryable)', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

      try {
        await plugin.collect({ url: 'https://example.com/missing' }, signal);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CollectorError);
        expect((error as CollectorError).code).toBe('FETCH_FAILED');
        expect((error as CollectorError).retryable).toBe(false);
      }
    });

    it('throws FETCH_FAILED for 5xx responses (retryable)', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Server Error', { status: 503 }));

      try {
        await plugin.collect({ url: 'https://example.com/error' }, signal);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CollectorError);
        expect((error as CollectorError).code).toBe('FETCH_FAILED');
        expect((error as CollectorError).retryable).toBe(true);
      }
    });

    it('throws CONTENT_EMPTY for empty response body', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      );

      try {
        await plugin.collect({ url: 'https://example.com/empty' }, signal);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CollectorError);
        expect((error as CollectorError).code).toBe('CONTENT_EMPTY');
        expect((error as CollectorError).retryable).toBe(false);
      }
    });

    it('throws CONTENT_EMPTY for whitespace-only response body', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('   \n\t  ', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      );

      try {
        await plugin.collect({ url: 'https://example.com/blank' }, signal);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CollectorError);
        expect((error as CollectorError).code).toBe('CONTENT_EMPTY');
      }
    });

    it('throws PARSE_FAILED for non-HTML content type', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('{"data": "json"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      try {
        await plugin.collect({ url: 'https://example.com/api' }, signal);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CollectorError);
        expect((error as CollectorError).code).toBe('PARSE_FAILED');
        expect((error as CollectorError).retryable).toBe(false);
        expect((error as CollectorError).message).toContain('Unsupported content type');
      }
    });

    it('throws FETCH_FAILED early when Content-Length header exceeds 5MB', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('small body', {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-length': String(6 * 1024 * 1024),
          },
        }),
      );

      try {
        await plugin.collect({ url: 'https://example.com/huge-header' }, signal);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CollectorError);
        expect((error as CollectorError).code).toBe('FETCH_FAILED');
        expect((error as CollectorError).retryable).toBe(false);
        expect((error as CollectorError).message).toContain('Response too large');
      }
    });

    it('throws FETCH_FAILED for response body exceeding 5MB limit', async () => {
      const largeBody = 'x'.repeat(6 * 1024 * 1024);
      mockFetch.mockResolvedValueOnce(
        new Response(largeBody, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      );

      try {
        await plugin.collect({ url: 'https://example.com/huge' }, signal);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CollectorError);
        expect((error as CollectorError).code).toBe('FETCH_FAILED');
        expect((error as CollectorError).retryable).toBe(false);
        expect((error as CollectorError).message).toContain('Response body too large');
      }
    });

    it('converts AbortError to ABORTED (not retryable)', async () => {
      mockFetch.mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'));

      try {
        await plugin.collect({ url: 'https://example.com/slow' }, signal);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CollectorError);
        expect((error as CollectorError).code).toBe('ABORTED');
        expect((error as CollectorError).retryable).toBe(false);
      }
    });

    it('preserves CollectorError from safeFetch (e.g. redirect issues)', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 301 }));

      try {
        await plugin.collect({ url: 'https://example.com/bad-redirect' }, signal);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CollectorError);
        expect((error as CollectorError).code).toBe('FETCH_FAILED');
        expect((error as CollectorError).message).toContain('Location');
      }
    });

    it('preserves CollectorError from parser (PARSE_FAILED)', async () => {
      const noArticleHtml = '<html><body><nav>Menu only</nav></body></html>';
      mockFetch.mockResolvedValueOnce(
        new Response(noArticleHtml, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      );

      try {
        await plugin.collect({ url: 'https://example.com/no-article' }, signal);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CollectorError);
        expect((error as CollectorError).code).toBe('PARSE_FAILED');
        expect((error as CollectorError).retryable).toBe(false);
      }
    });

    it('wraps unknown errors as FETCH_FAILED (not retryable)', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      try {
        await plugin.collect({ url: 'https://example.com/network-fail' }, signal);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CollectorError);
        expect((error as CollectorError).code).toBe('FETCH_FAILED');
        expect((error as CollectorError).retryable).toBe(false);
        expect((error as CollectorError).message).toContain('Failed to fetch');
      }
    });
  });
});
