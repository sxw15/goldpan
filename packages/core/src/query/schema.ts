import { z } from 'zod';

// ─── Query understanding output ──────────────────────────────

export const QUERY_COMPLEXITY = ['simple', 'complex', 'global'] as const;
export type QueryComplexity = (typeof QUERY_COMPLEXITY)[number];

export const queryUnderstandingSchema = z.object({
  /** FTS5 search keywords (substantive terms extracted from query) */
  keywords: z.array(z.string().max(200)).max(20).default([]),
  /** Whether the user mentions any time-related expression */
  hasTimeHint: z.boolean().default(false),
  /** Category path keywords (match categories.path) */
  categoryHints: z.array(z.string().max(200)).max(10).default([]),
  /** Knowledge point type filter */
  pointType: z.enum(['fact', 'opinion', 'any']).default('any'),
  /** Source kind filter */
  sourceKind: z.enum(['external', 'user', 'any']).default('any'),
  complexity: z.enum(QUERY_COMPLEXITY).default('simple'),
});
export type QueryUnderstanding = z.infer<typeof queryUnderstandingSchema>;

// ─── Query answer output ─────────────────────────────────────
export const queryResultSchema = z.object({
  answer: z.string().min(1).max(10_000),
  citedEntityIds: z.array(z.number()).max(100).default([]),
  citedPointIds: z.array(z.number()).max(200).default([]),
  confidence: z.enum(['high', 'medium', 'low', 'no_data']),
});
export type QueryResult = z.infer<typeof queryResultSchema>;
