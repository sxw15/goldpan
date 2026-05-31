import { describe, expect, it } from 'vitest';
import { escapeHtml, markdownToTelegramHtml } from '../../src/render/html.js';

describe('escapeHtml', () => {
  it('escapes <, >, &', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });
});

describe('markdownToTelegramHtml', () => {
  it('converts **bold** to <b>', () => {
    expect(markdownToTelegramHtml('**hi**')).toContain('<b>hi</b>');
  });

  it('converts *italic* to <i>', () => {
    expect(markdownToTelegramHtml('*hi*')).toContain('<i>hi</i>');
  });

  it('converts inline `code` to <code>', () => {
    expect(markdownToTelegramHtml('`x()`')).toContain('<code>x()</code>');
  });

  it('converts fenced code blocks to <pre>', () => {
    const html = markdownToTelegramHtml('```\nfoo\n```');
    expect(html).toMatch(/<pre>/);
    expect(html).toContain('foo');
  });

  it('strips disallowed tags (e.g. <img>, <script>)', () => {
    const html = markdownToTelegramHtml('![x](http://e.com/x.png) <script>alert(1)</script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
  });

  it('preserves links as <a href>', () => {
    expect(markdownToTelegramHtml('[goldpan](https://example.com)')).toContain(
      '<a href="https://example.com">goldpan</a>',
    );
  });
});
