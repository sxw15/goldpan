import type { ConversationContext } from '../conversation/types';
import type { LlmCallRepository } from '../db/repositories/types';
import { errorMessage, PipelineError } from '../errors';
import { t } from '../i18n/index';
import type { Language } from '../i18n/types';
import type { CallLlmFn } from '../pipeline/types';
import { compilePrompt, computePromptHash, loadPromptTemplate } from '../prompts/loader';
import { projectConversationForPrompt } from './conversation-prompt';
import type { QueryResult } from './schema';
import { queryResultSchema } from './schema';
import type { SearchResult } from './search';

export interface GenerateAnswerDeps {
  callLlm: CallLlmFn;
  llmCallRepo: LlmCallRepository;
  language: Language;
  logPayloads: boolean;
  signal?: AbortSignal;
  /** Optional multi-turn conversation context — lets the LLM continue prior threads. */
  conversation?: ConversationContext;
}

export type PromptVariant = 'standard' | 'analytical' | 'summary';

export interface AnswerOptions {
  promptVariant?: PromptVariant;
  relationsContext?: string;
}

/** Maximum characters for knowledge data sent to answer LLM. */
const MAX_KNOWLEDGE_DATA_CHARS = 30_000;
/** Maximum characters per entity block to prevent one entity from dominating the prompt. */
const MAX_ENTITY_BLOCK_CHARS = 5_000;

/** Format search results into a structured text block for the answer LLM. */
function formatKnowledgeData(results: SearchResult): string {
  if (results.entities.length === 0) return '';

  const blocks: string[] = [];
  let totalLength = 0;

  for (const entity of results.entities) {
    const lines: string[] = [];
    lines.push(`## Entity [id:${entity.id}] ${entity.name}`);
    if (entity.description) {
      lines.push(`Description: ${entity.description}`);
    }
    if (entity.categoryPaths.length > 0) {
      lines.push(`Categories: ${entity.categoryPaths.join(', ')}`);
    }
    if (entity.aliases.length > 0) {
      lines.push(`Aliases: ${entity.aliases.join(', ')}`);
    }
    if (entity.lastSourceDate) {
      lines.push(`Last updated: ${entity.lastSourceDate}`);
    }
    if (entity.points.length > 0) {
      lines.push('Knowledge points:');
      let pointChars = 0;
      for (const point of entity.points) {
        const line = `- [point:${point.id}] (${point.type}) ${point.content}`;
        // Allow at least the first point even if it exceeds the cap
        if (pointChars > 0 && pointChars + line.length > MAX_ENTITY_BLOCK_CHARS) break;
        lines.push(line);
        pointChars += line.length;
      }
    }
    const block = lines.join('\n');
    if (totalLength + block.length > MAX_KNOWLEDGE_DATA_CHARS && blocks.length > 0) break;
    blocks.push(block);
    totalLength += block.length;
  }

  return blocks.join('\n\n');
}

/**
 * Use LLM to synthesize a natural language answer from search results.
 * Uses the capable query model (step = 'query').
 */
export async function generateQueryAnswer(
  rawQuery: string,
  searchResults: SearchResult,
  deps: GenerateAnswerDeps,
  options?: AnswerOptions,
): Promise<QueryResult> {
  const hasData = searchResults.entities.length > 0;
  const knowledgeData = formatKnowledgeData(searchResults);

  const isAnalytical = options?.promptVariant === 'analytical';
  const isSummary = options?.promptVariant === 'summary';
  const relationsContext = options?.relationsContext ?? '';

  const systemTemplate = loadPromptTemplate('query-system', deps.language);
  const userTemplate = loadPromptTemplate('query', deps.language);
  const conversationTurns = projectConversationForPrompt(deps.conversation);
  const hasConversation = conversationTurns.length > 0;
  const system = compilePrompt(systemTemplate, { isAnalytical, isSummary, hasConversation });
  const prompt = compilePrompt(userTemplate, {
    userQuery: rawQuery,
    knowledgeData,
    hasData,
    hasRelations: !!relationsContext,
    relationsContext,
    isSummary,
    hasConversation,
    conversationTurns,
  });
  const promptHash = computePromptHash(systemTemplate, userTemplate);

  if (deps.signal?.aborted) {
    throw new Error('Query answer generation aborted');
  }

  try {
    return await deps.callLlm({
      step: 'query',
      schema: queryResultSchema,
      system,
      prompt,
      promptHash,
      sourceId: null,
      llmCallRepo: deps.llmCallRepo,
      logPayloads: deps.logPayloads,
      signal: deps.signal,
    });
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    throw new Error(
      t('query.answer_failed', {
        message: errorMessage(err),
      }),
      { cause: err },
    );
  }
}
