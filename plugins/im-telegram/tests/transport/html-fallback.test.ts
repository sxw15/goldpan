import { describe, expect, it } from 'vitest';
import { htmlToPlain, isTelegramParseEntitiesError } from '../../src/transport/html-fallback.js';

describe('isTelegramParseEntitiesError', () => {
  it('matches the canonical 400 "can\'t parse entities"', () => {
    expect(
      isTelegramParseEntitiesError({
        error_code: 400,
        description: "Bad Request: can't parse entities: Unsupported start tag at byte offset 10",
      }),
    ).toBe(true);
  });

  it('matches unmatched/unexpected end tag descriptions', () => {
    expect(
      isTelegramParseEntitiesError({
        error_code: 400,
        description: 'Bad Request: unmatched end tag at byte offset 42',
      }),
    ).toBe(true);
    expect(
      isTelegramParseEntitiesError({
        error_code: 400,
        description: 'Bad Request: unexpected end tag',
      }),
    ).toBe(true);
  });

  it('ignores non-400 errors even with matching description', () => {
    expect(
      isTelegramParseEntitiesError({
        error_code: 429,
        description: "can't parse entities",
      }),
    ).toBe(false);
  });

  it('ignores 400 errors with unrelated description', () => {
    expect(
      isTelegramParseEntitiesError({
        error_code: 400,
        description: 'Bad Request: chat not found',
      }),
    ).toBe(false);
  });

  it('ignores non-object/falsy inputs', () => {
    expect(isTelegramParseEntitiesError(null)).toBe(false);
    expect(isTelegramParseEntitiesError(undefined)).toBe(false);
    expect(isTelegramParseEntitiesError('string error')).toBe(false);
    expect(isTelegramParseEntitiesError(new Error('plain'))).toBe(false);
  });
});

describe('htmlToPlain', () => {
  it('strips inline formatting tags', () => {
    expect(htmlToPlain('<b>Alpha</b> and <i>Beta</i>')).toBe('Alpha and Beta');
  });

  it('preserves anchor text but drops the tag and href', () => {
    expect(htmlToPlain('See <a href="https://example.com/x">Entity</a>')).toBe('See Entity');
  });

  it('converts block tags to newlines without duplicate blank lines', () => {
    expect(htmlToPlain('<p>line1</p><p>line2</p>')).toBe('line1\n\nline2');
  });

  it('decodes the HTML entity escapes Telegram HTML parse mode requires', () => {
    expect(htmlToPlain('a &lt; b &amp;&amp; c &gt; d')).toBe('a < b && c > d');
    expect(htmlToPlain('&quot;quoted&quot; and &#39;apostrophe&#39;')).toBe(
      '"quoted" and \'apostrophe\'',
    );
  });

  it('handles the renderQuery output shape', () => {
    const html = [
      'Answer body',
      '',
      '<i>confidence: low</i>',
      '',
      '<b>Sources</b>',
      '• <a href="https://x/1">Name</a>',
    ].join('\n');
    expect(htmlToPlain(html)).toBe(
      ['Answer body', '', 'confidence: low', '', 'Sources', '• Name'].join('\n'),
    );
  });
});
