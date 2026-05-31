import type { FilterDecision, InboundFilter, InboundMessage } from '@goldpan/im-runtime';

export interface TelegramAllowlistOptions {
  allowedChatIds: string[];
}

/**
 * Fail-closed chat allowlist.
 *
 * Unauthorized chats are SILENTLY rejected (no reply). Replying to disallowed chats
 * would (a) leak the bot's existence to attackers probing for it and (b) burn the
 * bot's Telegram API quota since the inbound dedupe table cannot help — a remote
 * attacker can synthesize unique `message_id`s indefinitely. The cost of the
 * silence is that a legitimate operator who forgets to add a chat to the allowlist
 * sees no response; that's an acceptable trade for a self-hosted bot whose
 * allowlist is configured at deploy time.
 */
export class TelegramAllowlistFilter implements InboundFilter {
  readonly name = 'telegram-allowlist';
  /**
   * Security-class gate — MUST run on synthesized re-dispatches too.
   * A chat removed from the allowlist after a clarify card was sent
   * must not be able to drive new turns through stale inline buttons.
   * Declared explicitly (rather than relying on the `types.ts` default)
   * so the intent is visible at the class body, not a remote default.
   */
  readonly runOnSynthesized = true;
  private allowed: Set<string>;

  constructor(opts: TelegramAllowlistOptions) {
    const cleaned = (opts.allowedChatIds ?? []).map((s) => s.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      throw new Error(
        'TelegramAllowlistFilter: GOLDPAN_IM_TELEGRAM_ALLOWED_CHAT_IDS allowlist is required. ' +
          'Set it to a comma-separated list of telegram chat IDs to allow.',
      );
    }
    this.allowed = new Set(cleaned);
  }

  shouldHandle(msg: InboundMessage): FilterDecision {
    if (this.allowed.has(msg.chatId)) return { type: 'pass' };
    return { type: 'reject' };
  }
}
