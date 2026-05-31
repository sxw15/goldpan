import type { ConversationRepository } from '@goldpan/core/conversation';
import type { SessionRef } from '../types.js';
import { isReplayAuthorized, type ReplayAuthActor } from './replay-auth.js';
import { parseSessionKey } from './router.js';

export type ClarifyReplayResult =
  | {
      status: 'ok';
      /** The option label string the user tapped. */
      text: string;
      /** `conversation_messages.sessionKey` of the originating clarify message. */
      sessionKey: string;
      /** Authoritative routing ref reconstructed from the stored sessionKey. */
      sessionRef: SessionRef;
    }
  | { status: 'stale'; reason: ClarifyStaleReason };

export type ClarifyKeyedReplayResult =
  | {
      status: 'ok';
      conversationId: number;
      /** `conversation_messages.sessionKey` of the originating clarify message. */
      sessionKey: string;
      /** Authoritative routing ref reconstructed from the stored sessionKey. */
      sessionRef: SessionRef;
    }
  | { status: 'stale'; reason: Exclude<ClarifyStaleReason, 'invalid_option_index'> };

export type ClarifyStaleReason =
  | 'missing' // repo returned no row
  | 'archived' // conversation_archived_at is set
  | 'unauthorized' // actor tuple mismatched sessionKey
  | 'not_clarify' // metadata.resultType !== 'clarify'
  | 'invalid_option_index'; // idx out of range or empty choice

/**
 * Resolve a clarify button-tap / card-action event into either the option
 * string to replay or a typed stale reason. Shared by every channel's
 * callback handler so the trust chain around `conversation_messages.metadata`
 * lives in exactly one place.
 *
 * Phase 1 / early Phase 2 had each adapter duplicate this: Telegram's
 * `buildClarifyReplay` did metadata unpacking + authorization locally;
 * Feishu's `handleCardActionEvent` re-implemented the same but initially
 * forgot the authorization step. Centralising it here closes that class
 * of regression (CLAUDE.md §3 中央化防御).
 *
 * Authorization runs BEFORE metadata access on purpose — a cross-chat
 * replay attempt must not even observe the private `options` array before
 * being rejected.
 */
export function resolveClarifyReplay(input: {
  repo: ConversationRepository;
  conversationMessageId: number;
  optionIndex: number;
  actor: ReplayAuthActor;
}): ClarifyReplayResult {
  const row = input.repo.getMessageById(input.conversationMessageId);
  if (!row) return { status: 'stale', reason: 'missing' };
  if (row.conversationArchivedAt != null) return { status: 'stale', reason: 'archived' };
  const parsedSession = parseSessionKey(row.sessionKey);
  if (!parsedSession || !isReplayAuthorized(parsedSession, input.actor)) {
    return { status: 'stale', reason: 'unauthorized' };
  }
  const meta = row.metadata;
  if (!meta || meta.resultType !== 'clarify') {
    return { status: 'stale', reason: 'not_clarify' };
  }
  const options = Array.isArray(meta.options) ? meta.options : [];
  const choice = options[input.optionIndex];
  if (typeof choice !== 'string' || choice.length === 0) {
    return { status: 'stale', reason: 'invalid_option_index' };
  }
  const sessionRef: SessionRef = {
    channelId: parsedSession.channelId,
    accountId: parsedSession.accountId,
    chatId: parsedSession.chatId,
    userId: parsedSession.scope === 'per_user' ? parsedSession.userId : input.actor.userId,
    ...(parsedSession.threadId !== undefined ? { threadId: parsedSession.threadId } : {}),
  };
  return { status: 'ok', text: choice, sessionKey: row.sessionKey, sessionRef };
}

/**
 * Resolve keyed clarify buttons (`intentKey` + optional payload). These do
 * not replay an indexed option label, but they must share the same trust chain
 * as legacy option-index callbacks: the row must still be a live clarify turn,
 * and the callback actor must still match the persisted sessionKey before the
 * adapter is allowed to dispatch with `forcedIntent`.
 */
export function resolveClarifyKeyedReplay(input: {
  repo: ConversationRepository;
  conversationMessageId: number;
  actor: ReplayAuthActor;
}): ClarifyKeyedReplayResult {
  const row = input.repo.getMessageById(input.conversationMessageId);
  if (!row) return { status: 'stale', reason: 'missing' };
  if (row.conversationArchivedAt != null) return { status: 'stale', reason: 'archived' };
  const parsedSession = parseSessionKey(row.sessionKey);
  if (!parsedSession || !isReplayAuthorized(parsedSession, input.actor)) {
    return { status: 'stale', reason: 'unauthorized' };
  }
  const meta = row.metadata;
  if (!meta || meta.resultType !== 'clarify') {
    return { status: 'stale', reason: 'not_clarify' };
  }
  const sessionRef: SessionRef = {
    channelId: parsedSession.channelId,
    accountId: parsedSession.accountId,
    chatId: parsedSession.chatId,
    userId: parsedSession.scope === 'per_user' ? parsedSession.userId : input.actor.userId,
    ...(parsedSession.threadId !== undefined ? { threadId: parsedSession.threadId } : {}),
  };
  return {
    status: 'ok',
    conversationId: row.conversationId,
    sessionKey: row.sessionKey,
    sessionRef,
  };
}
