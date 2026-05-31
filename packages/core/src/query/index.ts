import type { ILogObj, Logger } from 'tslog';
import type { ConversationContext } from '../conversation/types';
import type { DrizzleDB } from '../db/connection';
import type { LlmCallRepository } from '../db/repositories/types';
import { errorMessage } from '../errors';
import { t } from '../i18n/index';
import type { Language } from '../i18n/types';
import type { CallLlmFn } from '../pipeline/types';
import type { PromptVariant } from './answer';
import { generateQueryAnswer } from './answer';
import { expandWithRelations } from './relations';
import type { QueryComplexity, QueryResult } from './schema';
import type { SearchOptions } from './search';
import { type SearchResult, searchKnowledge } from './search';
import { understandQuery } from './understand';

export type { AnswerOptions, PromptVariant } from './answer';
export { generateQueryAnswer } from './answer';
export {
  type ExpandWithRelationsOptions,
  type ExpandWithRelationsResult,
  expandWithRelations,
} from './relations';
export type { QueryResult } from './schema';
export {
  QUERY_COMPLEXITY,
  type QueryComplexity,
  type QueryUnderstanding,
  queryResultSchema,
  queryUnderstandingSchema,
} from './schema';
export type { SearchOptions, SearchResult, SearchResultEntity, SearchResultPoint } from './search';
export { searchKnowledge } from './search';
export { understandQuery } from './understand';

export interface QueryDeps {
  db: DrizzleDB;
  callLlm: CallLlmFn;
  llmCallRepo: LlmCallRepository;
  language: Language;
  logPayloads: boolean;
  llmTimeout: number;
  signal?: AbortSignal;
  embeddingProvider?: import('../embedding/types').EmbeddingProvider | null;
  logger?: Logger<ILogObj>;
  /**
   * Optional multi-turn conversation context (forwarded by IM Runtime).
   * When present, recent turns are injected into both the query-understand
   * and query-answer prompts so the LLM can resolve anaphora ("那这家公司"),
   * follow-up questions ("还有呢"), and reference earlier discussion.
   * Web/CLI callers leave this undefined → behavior reverts to single-turn.
   */
  conversation?: ConversationContext;
}

/** Maximum query length (characters) to prevent LLM token waste. */
export const MAX_QUERY_LENGTH = 2000;

function deriveSearchOptions(complexity: QueryComplexity, deps: QueryDeps): SearchOptions {
  const base: SearchOptions = {
    embeddingProvider: deps.embeddingProvider,
  };
  switch (complexity) {
    case 'simple':
      return base;
    case 'complex':
      return base;
    case 'global':
      return { ...base, maxEntities: 50, emphasizeTime: true };
  }
}

function derivePromptVariant(complexity: QueryComplexity): PromptVariant {
  switch (complexity) {
    case 'simple':
      return 'standard';
    case 'complex':
      return 'analytical';
    case 'global':
      return 'summary';
  }
}

/**
 * Top-level knowledge query function.
 *
 * Three-step flow:
 * 1. understandQuery() — LLM decomposes query into structured search params (~0.5s)
 * 2. searchKnowledge() — Multi-strategy retrieval (FTS5 + time + category + JSON keywords, ~50ms)
 * 3. generateQueryAnswer() — LLM synthesizes answer from search results (~2–5s)
 */
export async function queryKnowledge(rawQuery: string, deps: QueryDeps): Promise<QueryResult> {
  const trimmed = rawQuery.trim();
  if (!trimmed) {
    throw new Error(t('query.empty_query'));
  }
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new Error(t('query.too_long', { limit: String(MAX_QUERY_LENGTH) }));
  }

  const llmDeps = {
    callLlm: deps.callLlm,
    llmCallRepo: deps.llmCallRepo,
    language: deps.language,
    logPayloads: deps.logPayloads,
    signal: deps.signal,
    conversation: deps.conversation,
  };

  // Step 1: Query understanding (fast model)
  const understanding = await understandQuery(trimmed, llmDeps);

  // Step 2: Adaptive search
  const searchOptions: SearchOptions = {
    ...deriveSearchOptions(understanding.complexity, deps),
    rawQuery: trimmed,
  };
  let searchResults: SearchResult;
  try {
    searchResults = await searchKnowledge(understanding, deps.db, deps.language, searchOptions);
  } catch (err) {
    throw new Error(
      t('query.search_failed', {
        message: errorMessage(err),
      }),
      { cause: err },
    );
  }

  // Step 2.5: Relation expansion (complex only)
  let relationsContext = '';
  if (understanding.complexity === 'complex') {
    const expanded = expandWithRelations(searchResults, deps.db, { logger: deps.logger });
    relationsContext = expanded.relationsContext;
    searchResults = expanded.searchResults;
  }

  // Step 3: Adaptive answer generation
  const promptVariant = derivePromptVariant(understanding.complexity);
  const result = await generateQueryAnswer(trimmed, searchResults, llmDeps, {
    promptVariant,
    relationsContext,
  });

  const validEntityIds = new Set(searchResults.entities.map((e) => e.id));
  const validPointIds = new Set(searchResults.entities.flatMap((e) => e.points.map((p) => p.id)));

  // LLM 偶尔会在 citedEntityIds/citedPointIds 里重复同一 id（尤其在长答案里），
  // 下游 chips 按数组顺序渲染，所以这里 filter + dedupe 一起做（Set 保留首次插入顺序）。
  return {
    ...result,
    citedEntityIds: [...new Set(result.citedEntityIds.filter((id) => validEntityIds.has(id)))],
    citedPointIds: [...new Set(result.citedPointIds.filter((id) => validPointIds.has(id)))],
  };
}
