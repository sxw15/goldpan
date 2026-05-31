import { type ParsedSessionKey, parseSessionKey } from './router.js';

/**
 * The inbound actor whose callback / card-action we're about to replay.
 * Every channel's replayable artifact (Telegram clarify `callback_data`,
 * Feishu card `action.value`, …) is keyed by an enumerable
 * `conversationMessageId` with no HMAC, so the only thing stopping chatB
 * from replaying chatA's payload is a compare against the originating
 * sessionKey.
 */
export interface ReplayAuthActor {
  channelId: string;
  accountId: string;
  chatId: string;
  userId: string;
}

/**
 * Authorize a replay event against the sessionKey recorded on the
 * originating conversation row.
 *
 * Rejects when channel, account, chat, or (for per_user) user do not
 * match. `threadId` is intentionally NOT compared — see the threat
 * model below for why that is deliberately safe rather than a TODO.
 *
 * Threat model
 * ------------
 * Every clarify / card-action payload is `{conversationMessageId, optionIndex}`
 * — no HMAC, no nonce, just an integer that an attacker could enumerate.
 * The defenses are:
 *
 *   1. **This function**: the inbound actor (channel / account / chat /
 *      [user]) must match the actor stored on the originating
 *      conversation row. A user in chatB cannot replay chatA's payload
 *      because chatId mismatches.
 *
 *   2. **`sessionKeyOverride` on the synthesized re-dispatch**: the
 *      router uses the sessionKey persisted on the conversation row,
 *      not anything derived from the inbound event. This is why
 *      threadId comparison is deliberately omitted here:
 *
 *      - The originating thread is already encoded in the persisted
 *        sessionKey (`...:t=<threadId>`), so the synthesized
 *        re-dispatch is *guaranteed* to land in the originating
 *        thread regardless of which thread the inbound carries.
 *      - Many platforms strip thread metadata from button taps:
 *        Telegram `callback_query` has no thread_id at all, and
 *        Feishu only attaches it for `chat_type === 'group'`. Comparing
 *        threadId would force us to either reject every legitimate
 *        Telegram clarify tap or invent ad-hoc per-channel exemptions.
 *      - A user in the same chat seeing a card sent into thread A
 *        cannot use that card to influence thread B even by tapping
 *        from thread B, because step (2) overrides the routing back
 *        to thread A. The "attack" reduces to "user replays their own
 *        card in their own chat" — which is exactly what clarify is
 *        for.
 *
 * Future channels (Slack threads, Discord, WeChat, …) MUST keep both
 * defenses intact: removing (1) re-opens cross-chat replay, removing (2)
 * re-opens cross-thread routing.
 *
 * Exported from `@goldpan/im-runtime` so every channel adapter's replay
 * handler can call the same check rather than re-deriving the segment
 * layout locally (a Phase 2 centralization — prior to this, Telegram
 * owned a private copy and Feishu's card-action handler skipped
 * authorization entirely).
 */
export function isReplayAuthorized(
  sessionKey: string | ParsedSessionKey,
  actor: ReplayAuthActor,
): boolean {
  const parsed = typeof sessionKey === 'string' ? parseSessionKey(sessionKey) : sessionKey;
  if (!parsed) return false;
  if (parsed.channelId !== actor.channelId) return false;
  if (parsed.accountId !== actor.accountId) return false;
  if (parsed.chatId !== actor.chatId) return false;
  if (parsed.scope === 'per_user' && parsed.userId !== actor.userId) return false;
  return true;
}
