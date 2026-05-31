/**
 * Shared LLM step → model key mapping.
 *
 * Used by bootstrap.ts (server worker) and apps/web/src/lib/llm.ts (web singleton)
 * to resolve which config model ID to use for each pipeline/query step.
 */

import type { LlmStep } from '../db/repositories/types';

export type LlmModelKey =
  | 'classifier'
  | 'extractor'
  | 'matcher'
  | 'comparator'
  | 'verifier'
  | 'relator'
  | 'translator'
  | 'intent'
  | 'query'
  | 'digestSummary'
  | 'digestAction';

// `satisfies Record<LlmStep, LlmModelKey>` ensures compile-time exhaustiveness:
// adding a new LlmStep without a mapping here is a type error.
export const STEP_TO_MODEL_KEY = {
  classifier: 'classifier',
  extractor: 'extractor',
  matcher: 'matcher',
  comparator: 'comparator',
  verifier: 'verifier',
  relator: 'relator',
  translator: 'translator',
  intent_classifier: 'intent',
  query_understand: 'intent',
  query: 'query',
  tracking_action_parser: 'intent',
  github_action_parser: 'intent',
  digest_summary: 'digestSummary',
  digest_action_parser: 'digestAction',
} satisfies Record<LlmStep, LlmModelKey>;

/**
 * Resolve which config LLM model key drives a given pipeline/query step.
 *
 * Thin wrapper over {@link STEP_TO_MODEL_KEY} — exists so call sites read as
 * intent ("which model for this step?") rather than an object lookup.
 */
export function resolveModelKeyForStep(step: LlmStep): LlmModelKey {
  return STEP_TO_MODEL_KEY[step];
}
