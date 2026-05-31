import { describe, expect, it } from 'vitest';
import { searchInputSchema, searchOutputSchema } from '../../src/plugins/search-schema';

describe('searchInputSchema', () => {
  it('accepts minimal valid input', () => {
    const result = searchInputSchema.parse({ query: 'test' });
    expect(result.query).toBe('test');
    expect(result.maxResults).toBe(10); // default
    expect(result.timeRange).toBe('any'); // default
  });

  it('rejects empty query', () => {
    expect(() => searchInputSchema.parse({ query: '' })).toThrow();
  });

  it('accepts full input', () => {
    const result = searchInputSchema.parse({
      query: 'hello world',
      maxResults: 20,
      language: 'zh',
      timeRange: 'week',
    });
    expect(result.maxResults).toBe(20);
    expect(result.language).toBe('zh');
    expect(result.timeRange).toBe('week');
  });
});

describe('searchOutputSchema', () => {
  it('validates correct output', () => {
    const result = searchOutputSchema.parse({
      results: [{ url: 'https://example.com', title: 'Test', snippet: 'Hello' }],
      searchEngine: 'tavily',
    });
    expect(result.results).toHaveLength(1);
    expect(result.searchEngine).toBe('tavily');
  });

  it('rejects invalid URL in results', () => {
    expect(() =>
      searchOutputSchema.parse({
        results: [{ url: 'not-a-url', title: 'T', snippet: 'S' }],
        searchEngine: 'test',
      }),
    ).toThrow();
  });
});
