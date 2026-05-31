import { z } from 'zod';

export const searchInputSchema = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(50).default(10),
  language: z.string().optional(),
  timeRange: z.enum(['day', 'week', 'month', 'any']).default('any'),
});

export type SearchInput = z.infer<typeof searchInputSchema>;

/** Maps the canonical `timeRange` enum to the single-letter code that Google's
 * `tbs=qdr:` and Tavily's `time_range` parameters accept. Excluded from
 * `'any'`, which means "no filter" — callers should branch before lookup. */
export const SEARCH_TIME_RANGE_QDR: Record<Exclude<SearchInput['timeRange'], 'any'>, string> = {
  day: 'd',
  week: 'w',
  month: 'm',
};

export const searchOutputSchema = z.object({
  results: z.array(
    z.object({
      url: z.url(),
      title: z.string(),
      snippet: z.string(),
      publishedAt: z.string().optional(),
    }),
  ),
  totalResults: z.number().optional(),
  searchEngine: z.string(),
});

export type SearchOutput = z.infer<typeof searchOutputSchema>;
