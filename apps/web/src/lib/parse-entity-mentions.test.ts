import { describe, expect, it } from 'vitest';
import { parseEntityMentions } from './parse-entity-mentions';

describe('parseEntityMentions', () => {
  it('returns empty array on empty / whitespace content', () => {
    expect(parseEntityMentions('')).toEqual([]);
    expect(parseEntityMentions('   ')).toEqual([]);
  });

  it('returns empty array when no mentions present', () => {
    expect(parseEntityMentions('plain text without any at-symbols')).toEqual([]);
    expect(parseEntityMentions('contact me at someone or whatever')).toEqual([]);
  });

  it('detects single ASCII mention', () => {
    expect(parseEntityMentions('hello @Anthropic world')).toEqual([
      { start: 6, end: 16, name: 'Anthropic' },
    ]);
  });

  it('detects multiple mentions and reports positions', () => {
    const out = parseEntityMentions('@A and @B then @C');
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.name)).toEqual(['A', 'B', 'C']);
    expect(out.every((m) => m.end > m.start)).toBe(true);
  });

  it('detects CJK names (一-龥 range)', () => {
    const out = parseEntityMentions('我读了 @公司 的文章');
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('公司');
  });

  it('detects mixed CJK + ASCII + underscore + digits', () => {
    const out = parseEntityMentions('@Anthropic_Claude_3_5');
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Anthropic_Claude_3_5');
  });

  it('supports bracketed mentions for entity names with spaces / punctuation', () => {
    const out = parseEntityMentions(
      'read @[Claude Code], @[OpenAI, Inc.], @[gpt-4o-mini], and @[Node.js]',
    );
    expect(out.map((m) => m.name)).toEqual([
      'Claude Code',
      'OpenAI, Inc.',
      'gpt-4o-mini',
      'Node.js',
    ]);
  });

  it('supports bracketed CJK mentions embedded in continuous text', () => {
    const out = parseEntityMentions('关注@[公司]最新动态');
    expect(out).toEqual([{ start: 2, end: 7, name: '公司' }]);
  });

  it('does not partial-match hyphenated / dotted / scoped identifiers as simple mentions', () => {
    const out = parseEntityMentions('@foo-bar @node.js @goldpan/core @baz!');
    expect(out.map((m) => m.name)).toEqual(['baz']);
  });

  it('allows punctuation and surrounding CJK text as simple mention boundaries', () => {
    const out = parseEntityMentions('关注@OpenAI。然后看（@Anthropic）');
    expect(out.map((m) => m.name)).toEqual(['OpenAI', 'Anthropic']);
  });

  it('ignores standalone @ symbol and e-mail addresses', () => {
    expect(parseEntityMentions('email@example.com is not a mention')).toEqual([]);
    expect(parseEntityMentions('@ is still standalone')).toEqual([]);
  });

  it('deduplicates duplicate occurrences via Set when caller does so', () => {
    const out = parseEntityMentions('@A and @A again');
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe('A');
    expect(out[1].name).toBe('A');
    // Parser preserves all occurrences with positions. Dedup is caller's
    // responsibility (component will Set-dedup before fetch).
  });
});
