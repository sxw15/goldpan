import { stripInternalKeys } from '../conversation/metadata-utils';
import type { ConversationMessage } from '../conversation/types';
import type { LlmCallRepository } from '../db/repositories/types';
import { errorMessage, PipelineError } from '../errors';
import { t } from '../i18n/index';
import type { Language } from '../i18n/types';
import type { CallLlmFn } from '../pipeline/types';
import type { IntentDeclaration } from '../plugins/types';
import { compilePrompt, computePromptHash, loadPromptTemplate } from '../prompts/loader';
import type { IntentResult } from './schema';
import { createIntentSchema } from './schema';

export interface ClassifyIntentDeps {
  callLlm: CallLlmFn;
  llmCallRepo: LlmCallRepository;
  language: Language;
  logPayloads: boolean;
  intentDeclarations: IntentDeclaration[];
  /** 6-message conversation window. Empty/omitted when caller has no conversation context. */
  recentMessages?: ConversationMessage[];
  signal?: AbortSignal;
}

const MAX_CONTENT_PER_MESSAGE_CHARS = 500;

/**
 * Render recentMessages into a prompt-safe shape. Strips __internal namespace
 * defensively (the repository layer already strips on read, but a leaked write
 * to ConversationMessage.metadata would otherwise echo classifier state back
 * to the next classifier call). Also truncates content to a hard 500-char cap
 * per message to keep the prompt bounded under long-paste inputs.
 */
function projectMessagesForPrompt(messages: ConversationMessage[]) {
  const now = Date.now();
  return messages.map((m) => {
    const elapsedMs = now - (m.createdAt instanceof Date ? m.createdAt.getTime() : 0);
    const elapsed = formatElapsed(elapsedMs);
    const metadata = m.metadata ? stripInternalKeys(m.metadata) : undefined;
    const content =
      m.content.length > MAX_CONTENT_PER_MESSAGE_CHARS
        ? `${m.content.slice(0, MAX_CONTENT_PER_MESSAGE_CHARS)}...`
        : m.content;
    return {
      id: m.id,
      role: m.role,
      elapsed,
      metadata,
      content,
    };
  });
}

function formatElapsed(ms: number): string {
  if (ms < 0) return 'now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/**
 * Classify user input into one of the registered intent names.
 * Prompt is assembled dynamically from intentDeclarations.
 *
 * NOTE: URL short-circuit logic lives in handleInput() (the caller).
 * This function always calls the LLM.
 */
export async function classifyIntent(
  rawInput: string,
  deps: ClassifyIntentDeps,
): Promise<IntentResult> {
  const { intentDeclarations, language } = deps;

  // Sort alphabetically for deterministic prompt generation
  const sorted = [...intentDeclarations].sort((a, b) => a.name.localeCompare(b.name));
  const intents = sorted.map((d) => ({
    name: d.name,
    description: d.descriptions?.[language] ?? d.description,
    examples: d.examples,
  }));
  const classificationHints = sorted.flatMap((d) => d.classificationHints ?? []).filter(Boolean);
  const intentNames = sorted.map((d) => d.name);

  const systemTemplate = loadPromptTemplate('intent_classifier-system', language);
  const userTemplate = loadPromptTemplate('intent_classifier', language);
  const system = compilePrompt(systemTemplate, { intents, classificationHints });

  const recentMessages = deps.recentMessages?.length
    ? projectMessagesForPrompt(deps.recentMessages)
    : undefined;

  const prompt = compilePrompt(userTemplate, {
    intentNames,
    userInput: rawInput,
    recentMessages,
  });
  const promptHash = computePromptHash(systemTemplate, userTemplate, ...intentNames);

  const schema = createIntentSchema(intentNames);

  if (deps.signal?.aborted) {
    throw new Error('Intent classification aborted');
  }

  try {
    return await deps.callLlm({
      step: 'intent_classifier',
      schema,
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
      t('intent.classification_failed', {
        message: errorMessage(err),
      }),
      { cause: err },
    );
  }
}
