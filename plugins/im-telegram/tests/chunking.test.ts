import { describe, expect, it } from 'vitest';
import { splitForTelegram } from '../src/chunking/split-4096.js';

describe('splitForTelegram', () => {
  it('returns single chunk for short text', () => {
    expect(splitForTelegram('hello')).toEqual(['hello']);
  });

  it('splits at paragraph boundary', () => {
    const a = 'a'.repeat(3000);
    const b = 'b'.repeat(3000);
    const chunks = splitForTelegram(`${a}\n\n${b}`, 4096);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(a);
    expect(chunks[1]).toBe(b);
  });

  it('force-splits oversized paragraph at last space', () => {
    const words = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(' ');
    const chunks = splitForTelegram(words, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
    }
  });

  it('handles text exactly at boundary', () => {
    const text = 'x'.repeat(4096);
    expect(splitForTelegram(text, 4096)).toEqual([text]);
  });

  it('force-split prefers end-of-tag (>) over mid-tag when no whitespace is available', () => {
    // Long run of small HTML tags with no whitespace anywhere. Force-split
    // must land at a `>` boundary so each chunk's HTML stays parseable —
    // splitting inside an open tag like `<b` would make the chunk unparseable
    // for Telegram. After rebalancing, every chunk still has matched `<`/`>`
    // counts (rebalancer only ever inserts well-formed open/close tags).
    const text = '<b>x</b>'.repeat(50); // 400 chars, plenty of `>` boundaries
    const chunks = splitForTelegram(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const opens = (c.match(/</g) ?? []).length;
      const closes = (c.match(/>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  it('force-split survives a pathological single oversized token without throwing', () => {
    // Pathological: 4500-char URL inside `<a href="...">x</a>` with NO
    // whitespace and NO intermediate `>` between the opening `<a` and the
    // closing `">`. No safe split point exists in this case — we accept that
    // output may be degraded (one chunk may contain a partial open tag), but
    // we MUST NOT throw, lose data, or produce empty chunks.
    const url = `https://example.com/${'q'.repeat(4500)}`;
    const html = `<a href="${url}">x</a>`;
    expect(() => splitForTelegram(html, 4096)).not.toThrow();
    const chunks = splitForTelegram(html, 4096);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
    expect(chunks.join('')).toContain('x</a>');
  });
});
