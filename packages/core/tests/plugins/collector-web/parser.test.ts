import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseHtml } from '../../../src/plugins/builtin/collector-web/parser.js';
import { CollectorError } from '../../../src/plugins/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf-8');
}

describe('parseHtml', () => {
  it('extracts article content as markdown', () => {
    const html = loadFixture('article.html');
    const result = parseHtml(html, 'https://example.com/article');

    expect(result.content).toContain('WebAssembly');
    expect(result.content).toContain('## What is WebAssembly?');
    expect(result.content).toContain('## Key Features');
  });

  it('strips navigation, sidebar, and footer noise', () => {
    const html = loadFixture('article.html');
    const result = parseHtml(html, 'https://example.com/article');

    expect(result.content).not.toContain('Related Articles');
    expect(result.content).not.toContain('All rights reserved');
    expect(result.content).not.toContain('editor@techblog');
  });

  it('extracts title', () => {
    const html = loadFixture('article.html');
    const result = parseHtml(html, 'https://example.com/article');

    expect(result.title).toContain('WebAssembly');
  });

  it('extracts published time from meta tags', () => {
    const html = loadFixture('article.html');
    const result = parseHtml(html, 'https://example.com/article');

    expect(result.publishedAt).toContain('2025-03-15');
  });

  it('converts code blocks to fenced markdown', () => {
    const html = loadFixture('article.html');
    const result = parseHtml(html, 'https://example.com/article');

    expect(result.content).toContain('WebAssembly.compile');
  });

  it('converts lists to markdown', () => {
    const html = loadFixture('article.html');
    const result = parseHtml(html, 'https://example.com/article');

    expect(result.content).toMatch(/[-*] .*Near-native performance/);
    expect(result.content).toMatch(/[-*] .*Language agnostic/);
  });

  it('returns null for missing metadata fields', () => {
    const html = `
      <!DOCTYPE html>
      <html><body>
        <article>
          <h1>Minimal Article</h1>
          <p>This is a simple article with enough content to satisfy the Readability extraction
          algorithm. It needs substantial text spread across multiple paragraphs to be recognized
          as the main content of the page.</p>
          <p>Adding a second paragraph with more details about the topic at hand. The algorithm
          typically needs a minimum amount of text and structure to properly identify and extract
          the main content from the surrounding page chrome.</p>
          <p>A third paragraph helps ensure reliable extraction across different Readability
          versions and configurations. Content length and paragraph count both factor into the
          scoring heuristics used by the library.</p>
        </article>
      </body></html>
    `;
    const result = parseHtml(html, 'https://example.com');

    expect(result.title).toBeTruthy();
    expect(result.author).toBeNull();
    expect(result.publishedAt).toBeNull();
  });

  it('throws PARSE_FAILED for empty HTML', () => {
    try {
      parseHtml('', 'https://example.com');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CollectorError);
      expect((error as CollectorError).code).toBe('PARSE_FAILED');
      expect((error as CollectorError).retryable).toBe(false);
    }
  });

  it('throws PARSE_FAILED for HTML without extractable article content', () => {
    const html = '<html><body><nav><a href="/">Home</a></nav></body></html>';

    try {
      parseHtml(html, 'https://example.com');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CollectorError);
      expect((error as CollectorError).code).toBe('PARSE_FAILED');
    }
  });
});
