import type { FilterDecision, InboundFilter, InboundMessage } from '@goldpan/im-runtime';
import { unwrapFeishuEvent } from '../event/unwrap.js';
import type { SentMessageCache } from '../sent-message-cache.js';

export interface FeishuGroupMentionOptions {
  /** Bot's open_id, resolved at adapter startup via `/open-apis/bot/v3/info`. */
  botOpenId: string;
  sentMessageCache: SentMessageCache;
}

/**
 * Feishu group-chat mention gate. In P2P chats every message passes (the
 * user is talking to the bot directly). In group chats the filter accepts
 * a message when any of:
 *
 *   - it contains a structured mention of the bot (`mentions[].id.open_id`
 *     matches `botOpenId`),
 *   - the text starts with `/` (user typed a command),
 *   - it is a reply to a recently-sent bot message (cache hit on
 *     `parent_id`).
 *
 * Everything else is rejected silently — groups are noisy and the bot
 * should not respond unless addressed.
 *
 * `runOnSynthesized = false`: clarify-card replays are an affirmative tap
 * on a card that was already addressed to the bot; running this gate
 * against the synthesized continuation would silently drop the tap (no
 * mention, no `/`, no parent_id).
 *
 * Reads `msg.raw` through `unwrapFeishuEvent` so it works regardless of
 * whether `@larksuiteoapi/node-sdk` already flattened the wire payload —
 * see `event/unwrap.ts`.
 */
export class FeishuGroupMentionFilter implements InboundFilter {
  readonly name = 'feishu-group-mention';
  readonly runOnSynthesized = false;
  constructor(private opts: FeishuGroupMentionOptions) {}

  shouldHandle(msg: InboundMessage): FilterDecision {
    const { inner } = unwrapFeishuEvent(msg.raw);
    const message = inner.message;
    const chatType = message?.chat_type;
    if (chatType === 'p2p') return { type: 'pass' };

    const text = (msg.text ?? '').trim();
    if (text.startsWith('/')) return { type: 'pass' };

    const mentions = message?.mentions ?? [];
    if (mentions.some((m) => m.id?.open_id === this.opts.botOpenId)) {
      return { type: 'pass' };
    }

    const parentId = message?.parent_id;
    if (parentId && this.opts.sentMessageCache.wasSent(msg.chatId, parentId)) {
      return { type: 'pass' };
    }

    return { type: 'reject' };
  }
}
