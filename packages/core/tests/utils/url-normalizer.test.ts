import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../../src/utils/url-normalizer.js';

describe('normalizeUrl', () => {
  describe('https unification', () => {
    it('upgrades http to https', () => {
      expect(normalizeUrl('http://example.com/page')).toBe('https://example.com/page');
    });
    it('preserves existing https', () => {
      expect(normalizeUrl('https://example.com/page')).toBe('https://example.com/page');
    });
  });

  describe('remove www prefix', () => {
    it('removes www from hostname', () => {
      expect(normalizeUrl('https://www.example.com/page')).toBe('https://example.com/page');
    });
    it('does not remove www from path', () => {
      expect(normalizeUrl('https://example.com/www.page')).toBe('https://example.com/www.page');
    });
    it('does not remove www from non-prefix position', () => {
      expect(normalizeUrl('https://subdomain.www.example.com')).toBe(
        'https://subdomain.www.example.com',
      );
    });
  });

  describe('remove trailing slash', () => {
    it('removes trailing slash from path', () => {
      expect(normalizeUrl('https://example.com/page/')).toBe('https://example.com/page');
    });
    it('preserves root path', () => {
      expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
    });
    it('preserves when path has content', () => {
      expect(normalizeUrl('https://example.com/a/b')).toBe('https://example.com/a/b');
    });
  });

  describe('remove tracking parameters', () => {
    it('removes utm_* parameters', () => {
      expect(normalizeUrl('https://example.com/page?utm_source=twitter&utm_medium=social')).toBe(
        'https://example.com/page',
      );
    });
    it('removes fbclid, gclid', () => {
      expect(normalizeUrl('https://example.com/page?fbclid=abc&id=123')).toBe(
        'https://example.com/page?id=123',
      );
    });
    it('preserves ref as functional param (not tracking)', () => {
      expect(normalizeUrl('https://example.com/page?ref=homepage&id=123')).toBe(
        'https://example.com/page?id=123&ref=homepage',
      );
    });
    it('removes mc_eid and _ga tracking params', () => {
      expect(normalizeUrl('https://example.com/page?mc_eid=abc&_ga=xyz&id=1')).toBe(
        'https://example.com/page?id=1',
      );
    });
    it('removes custom utm_ prefixed params', () => {
      expect(normalizeUrl('https://example.com/page?utm_custom=x&id=1')).toBe(
        'https://example.com/page?id=1',
      );
    });
  });

  describe('encoding preservation', () => {
    it('preserves encoded characters in query values', () => {
      expect(normalizeUrl('https://example.com?q=a%26b')).toBe('https://example.com/?q=a%26b');
    });
    it('removes tracking params while preserving encoding', () => {
      expect(normalizeUrl('https://example.com/search?q=test&utm_source=x')).toBe(
        'https://example.com/search?q=test',
      );
    });
  });

  describe('sort query parameters', () => {
    it('sorts params alphabetically', () => {
      expect(normalizeUrl('https://example.com/page?z=1&a=2&m=3')).toBe(
        'https://example.com/page?a=2&m=3&z=1',
      );
    });
  });

  describe('remove fragment', () => {
    it('removes hash fragment', () => {
      expect(normalizeUrl('https://example.com/page#section')).toBe('https://example.com/page');
    });
  });

  describe('remove userinfo', () => {
    it('removes user:password from URL', () => {
      expect(normalizeUrl('https://user:pass@example.com/page')).toBe('https://example.com/page');
    });
    it('removes user without password', () => {
      expect(normalizeUrl('https://user@example.com/page')).toBe('https://example.com/page');
    });
  });

  describe('lowercase hostname', () => {
    it('lowercases hostname', () => {
      expect(normalizeUrl('https://EXAMPLE.COM/Page')).toBe('https://example.com/Page');
    });
    it('preserves case in path', () => {
      expect(normalizeUrl('https://Example.Com/CaseSensitive')).toBe(
        'https://example.com/CaseSensitive',
      );
    });
  });

  describe('combined rules', () => {
    it('applies all rules together', () => {
      const input = 'http://www.EXAMPLE.COM/article/?utm_source=twitter&q=test&fbclid=abc#comments';
      expect(normalizeUrl(input)).toBe('https://example.com/article?q=test');
    });
    it('handles URL with no query or fragment', () => {
      expect(normalizeUrl('http://www.example.com/page')).toBe('https://example.com/page');
    });
    it('handles empty query after removing tracking params', () => {
      expect(normalizeUrl('https://example.com/page?utm_source=x')).toBe(
        'https://example.com/page',
      );
    });
  });

  describe('edge cases', () => {
    it('handles URL with port', () => {
      expect(normalizeUrl('http://example.com:8080/page')).toBe('https://example.com:8080/page');
    });
    it('handles URL with no path', () => {
      expect(normalizeUrl('http://www.example.com')).toBe('https://example.com');
    });
    it('throws on invalid URL', () => {
      expect(() => normalizeUrl('not a url')).toThrow();
    });
    it('throws on non-http protocol', () => {
      expect(() => normalizeUrl('ftp://example.com')).toThrow();
    });
  });
});
