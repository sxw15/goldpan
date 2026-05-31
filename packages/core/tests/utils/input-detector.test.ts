import { describe, expect, it } from 'vitest';
import { detectInputUrl } from '../../src/utils/input-detector.js';

describe('detectInputUrl', () => {
  describe('URL only', () => {
    it('detects plain URL', () => {
      const result = detectInputUrl('https://example.com/article');
      expect(result.hasUrl).toBe(true);
      expect(result.extractedUrl).toBe('https://example.com/article');
      expect(result.userAnnotation).toBeUndefined();
      expect(result.warnings).toBeUndefined();
    });
    it('detects URL with trailing whitespace', () => {
      const result = detectInputUrl('  https://example.com/page  ');
      expect(result.hasUrl).toBe(true);
      expect(result.extractedUrl).toBe('https://example.com/page');
    });
    it('detects http URL', () => {
      const result = detectInputUrl('http://example.com');
      expect(result.hasUrl).toBe(true);
      expect(result.extractedUrl).toBe('http://example.com');
    });
    it('detects URL with query params and fragment', () => {
      const result = detectInputUrl('https://example.com/page?q=test&p=2#section');
      expect(result.hasUrl).toBe(true);
      expect(result.extractedUrl).toBe('https://example.com/page?q=test&p=2#section');
    });
    it('detects URL with uppercase protocol', () => {
      const result = detectInputUrl('HTTPS://EXAMPLE.COM/article');
      expect(result.hasUrl).toBe(true);
      expect(result.extractedUrl).toBe('HTTPS://EXAMPLE.COM/article');
    });
    it('detects URL with mixed-case protocol', () => {
      const result = detectInputUrl('Https://Example.com/page');
      expect(result.hasUrl).toBe(true);
      expect(result.extractedUrl).toBe('Https://Example.com/page');
    });
    it('detects HTTP URL with uppercase protocol', () => {
      const result = detectInputUrl('HTTP://example.com');
      expect(result.hasUrl).toBe(true);
      expect(result.extractedUrl).toBe('HTTP://example.com');
    });
  });

  describe('URL with annotation', () => {
    it('detects URL followed by text', () => {
      const result = detectInputUrl('https://example.com/article This article is about AI tools');
      expect(result.hasUrl).toBe(true);
      expect(result.extractedUrl).toBe('https://example.com/article');
      expect(result.userAnnotation).toBe('This article is about AI tools');
    });
    it('detects text followed by URL', () => {
      const result = detectInputUrl('An article about AI https://example.com/article');
      expect(result.hasUrl).toBe(true);
      expect(result.extractedUrl).toBe('https://example.com/article');
      expect(result.userAnnotation).toBe('An article about AI');
    });
    it('trims annotation whitespace', () => {
      const result = detectInputUrl('  https://example.com/page   some notes  ');
      expect(result.userAnnotation).toBe('some notes');
    });
  });

  describe('multiple URLs', () => {
    it('extracts first URL, cleans remaining URLs from annotation, and warns', () => {
      const result = detectInputUrl('https://a.com and https://b.com');
      expect(result.hasUrl).toBe(true);
      expect(result.extractedUrl).toBe('https://a.com');
      expect(result.userAnnotation).toBe('and');
      expect(result.warnings).toContainEqual(expect.stringContaining('multiple URLs'));
    });
    it('strips all extra URLs from annotation', () => {
      const result = detectInputUrl('check this https://a.com 和 https://b.com these two');
      expect(result.hasUrl).toBe(true);
      expect(result.extractedUrl).toBe('https://a.com');
      expect(result.userAnnotation).toBe('check this 和 these two');
    });
  });

  describe('no URL', () => {
    it('detects plain text', () => {
      const result = detectInputUrl('Claude Code is an AI CLI tool');
      expect(result.hasUrl).toBe(false);
      expect(result.extractedUrl).toBeUndefined();
      expect(result.userAnnotation).toBeUndefined();
    });
    it('handles empty string', () => {
      const result = detectInputUrl('');
      expect(result.hasUrl).toBe(false);
    });
    it('does not match non-http protocols as URL', () => {
      const result = detectInputUrl('ftp://example.com/file');
      expect(result.hasUrl).toBe(false);
    });
    it('does not match URL-like text without protocol', () => {
      const result = detectInputUrl('example.com/page');
      expect(result.hasUrl).toBe(false);
    });
  });

  describe('trailing punctuation stripping', () => {
    it('strips trailing period from URL in sentence', () => {
      const result = detectInputUrl('check this https://example.com/article.');
      expect(result.extractedUrl).toBe('https://example.com/article');
    });
    it('strips trailing closing parenthesis', () => {
      const result = detectInputUrl('references (https://example.com/ref)');
      expect(result.extractedUrl).toBe('https://example.com/ref');
    });
    it('strips unmatched closing paren followed by CJK text', () => {
      const result = detectInputUrl('references (https://example.com/ref)this one is good');
      expect(result.extractedUrl).toBe('https://example.com/ref');
      expect(result.userAnnotation).toContain('this one is good');
    });
    it('preserves matched parentheses in URL path', () => {
      const result = detectInputUrl('https://en.wikipedia.org/wiki/AI_(concept) is great');
      expect(result.extractedUrl).toBe('https://en.wikipedia.org/wiki/AI_(concept)');
    });
    it('stops at Chinese punctuation boundary', () => {
      const result = detectInputUrl('https://example.com/article。');
      expect(result.extractedUrl).toBe('https://example.com/article');
    });
    it('preserves URL path parentheses when balanced', () => {
      const result = detectInputUrl('https://en.wikipedia.org/wiki/AI_(concept)');
      expect(result.extractedUrl).toBe('https://en.wikipedia.org/wiki/AI_(concept)');
    });
  });

  describe('CJK punctuation boundaries', () => {
    it('stops at Chinese comma — does not capture surrounding text', () => {
      const result = detectInputUrl('看这个：https://example.com/article，really good');
      expect(result.extractedUrl).toBe('https://example.com/article');
      expect(result.userAnnotation).toContain('really good');
    });
    it('detects comma-separated URLs as multiple', () => {
      const result = detectInputUrl('https://a.com，https://b.com');
      expect(result.hasUrl).toBe(true);
      expect(result.extractedUrl).toBe('https://a.com');
      expect(result.warnings).toContainEqual(expect.stringContaining('multiple URLs'));
    });
    it('stops at smart quotes (Unicode curly quotes)', () => {
      const result = detectInputUrl('\u201Chttps://example.com/article\u201Dthis one is good');
      expect(result.extractedUrl).toBe('https://example.com/article');
      expect(result.userAnnotation).toContain('this one is good');
    });
    it('stops at ASCII double quotes', () => {
      const result = detectInputUrl('take a look"https://example.com/article"this article');
      expect(result.extractedUrl).toBe('https://example.com/article');
    });
    it('stops at ASCII single quotes', () => {
      const result = detectInputUrl("Click 'https://example.com/page' for details");
      expect(result.extractedUrl).toBe('https://example.com/page');
    });
  });
});
