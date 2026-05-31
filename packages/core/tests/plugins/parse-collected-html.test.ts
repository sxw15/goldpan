import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCollectedHtml } from '../../src/plugins/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'collector-web', 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf-8');
}

describe('parseCollectedHtml', () => {
  it('returns collector output from rendered HTML', () => {
    const html = loadFixture('article.html');

    const result = parseCollectedHtml(html, 'https://example.com/article');

    expect(result.content).toContain('WebAssembly');
    expect(result.title).toContain('WebAssembly');
    expect(result.finalUrl).toBe('https://example.com/article');
    expect(result.metadata.collector_finalUrl).toBe('https://example.com/article');
  });

  it('keeps collector metadata keys prefixed', () => {
    const html = loadFixture('article.html');

    const result = parseCollectedHtml(html, 'https://example.com/article');

    for (const key of Object.keys(result.metadata)) {
      expect(key).toMatch(/^collector_/);
    }
  });
});
