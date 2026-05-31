import type { ConversationContext, ConversationMessage } from '../conversation/types';

/**
 * Maximum characters of conversation history to inject into prompts.
 * Prevents long histories from dominating the context window or driving
 * up token cost. Older turns are dropped first; the most recent turns are
 * always preserved.
 */
export const MAX_CONVERSATION_PROMPT_CHARS = 4_000;

/** Maximum characters per single turn — prevents one giant turn from squeezing out the rest. */
export const MAX_PER_TURN_CHARS = 1_200;

export interface ConversationTurnForPrompt {
  /** "user" or "assistant" — kept lowercase to match LLM convention. */
  role: 'user' | 'assistant';
  /** Truncated content (suffixed with "…" if cut). */
  content: string;
}

/**
 * Project a `ConversationContext` into a truncated, budget-bounded list of turns
 * suitable for embedding into an LLM prompt.
 *
 * Processing rules (in order):
 * 1. Truncate any single turn longer than {@link MAX_PER_TURN_CHARS} (with a `…`
 *    suffix) so one giant turn can't squeeze out the rest of the history.
 * 2. Walk turns from newest → oldest, keeping a running char budget of
 *    {@link MAX_CONVERSATION_PROMPT_CHARS}. Drop the oldest turns that don't fit;
 *    always keep at least the most recent turn even if it alone exceeds the budget.
 *
 * Returns turns in chronological order (oldest first) so the prompt reads naturally.
 *
 * Security note — `<gp_*>` framing-tag injection is **not** handled here. It is
 * enforced centrally by `prompts/loader.ts` `sanitizeValue()`, which is invoked
 * by every `compilePrompt()` call and recursively walks all variables (including
 * each `conversationTurns[].content`). The single-point defense is the project
 * convention; see `tests/prompts/loader.test.ts` for the security tests. Do NOT
 * add a second sanitization layer here without a documented reason — duplicated
 * defenses with different escape conventions create log/output inconsistencies.
 */
export function projectConversationForPrompt(
  conversation: ConversationContext | undefined,
): ConversationTurnForPrompt[] {
  if (!conversation) return [];
  const all = conversation.recentMessages;
  if (all.length === 0) return [];

  const trimmed: ConversationTurnForPrompt[] = all.map((m) => ({
    role: m.role,
    content: truncateTurn(m.content),
  }));

  // Walk from newest backwards so we always preserve the most recent context.
  const reversed = [...trimmed].reverse();
  const kept: ConversationTurnForPrompt[] = [];
  let budget = MAX_CONVERSATION_PROMPT_CHARS;
  for (const turn of reversed) {
    if (turn.content.length > budget && kept.length > 0) break;
    kept.push(turn);
    budget -= turn.content.length;
    if (budget <= 0) break;
  }
  return kept.reverse();
}

function truncateTurn(content: string): string {
  if (content.length <= MAX_PER_TURN_CHARS) return content;
  return `${content.slice(0, MAX_PER_TURN_CHARS - 1)}…`;
}

/** Test helper — re-export the underlying message type so tests can build fixtures. */
export type { ConversationMessage };
