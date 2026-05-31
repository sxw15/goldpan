import type { ConversationContext } from '../conversation/types';
import type { LlmCallRepository } from '../db/repositories/types';
import { errorMessage, PipelineError } from '../errors';
import { t } from '../i18n/index';
import type { Language } from '../i18n/types';
import type { CallLlmFn } from '../pipeline/types';
import { compilePrompt, computePromptHash, loadPromptTemplate } from '../prompts/loader';
import { projectConversationForPrompt } from './conversation-prompt';
import type { QueryUnderstanding } from './schema';
import { queryUnderstandingSchema } from './schema';

export interface UnderstandQueryDeps {
  callLlm: CallLlmFn;
  llmCallRepo: LlmCallRepository;
  language: Language;
  logPayloads: boolean;
  signal?: AbortSignal;
  /** Optional multi-turn conversation context — enables anaphora / follow-up resolution. */
  conversation?: ConversationContext;
}

/**
 * Use LLM to decompose a natural language query into structured search parameters.
 * Uses the fast/cheap intent model (step = 'query_understand').
 */
export async function understandQuery(
  rawQuery: string,
  deps: UnderstandQueryDeps,
): Promise<QueryUnderstanding> {
  const systemTemplate = loadPromptTemplate('query_understand-system', deps.language);
  const userTemplate = loadPromptTemplate('query_understand', deps.language);
  const conversationTurns = projectConversationForPrompt(deps.conversation);
  const hasConversation = conversationTurns.length > 0;
  const system = compilePrompt(systemTemplate, { hasConversation });
  const prompt = compilePrompt(userTemplate, {
    userQuery: rawQuery,
    hasConversation,
    conversationTurns,
  });
  const promptHash = computePromptHash(systemTemplate, userTemplate);

  if (deps.signal?.aborted) {
    throw new Error('Query understanding aborted');
  }

  try {
    return await deps.callLlm({
      step: 'query_understand',
      schema: queryUnderstandingSchema,
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
      t('query.understand_failed', {
        message: errorMessage(err),
      }),
      { cause: err },
    );
  }
}
