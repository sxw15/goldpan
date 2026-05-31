import type { FilterDecision, InboundFilter, InboundMessage } from '@goldpan/im-runtime';

export interface TelegramGroupMentionOptions {
  botUsername: string;
}

interface RawShape {
  message?: {
    chat?: { type?: string };
    text?: string;
    reply_to_message?: { from?: { username?: string; is_bot?: boolean } };
  };
}

export class TelegramGroupMentionFilter implements InboundFilter {
  readonly name = 'telegram-group-mention';
  /**
   * Synthesized re-dispatches (clarify-card replays from
   * `callback_query`) carry a Telegram `Update` whose `message` field
   * is empty — `callback_query` lives at the top level instead. Without
   * this opt-out, every clarify tap (DM and group alike) would fall
   * through to mention-checking against an option label like "Yes",
   * which has no `/`, no `@bot` mention, and no `reply_to_message`, and
   * would be silently rejected. The originating message already passed
   * this gate when its inline keyboard was sent; the affirmative tap is
   * a continuation, not a fresh inbound. Security defaults still apply
   * because `TelegramAllowlistFilter` does NOT opt out (Phase 2
   * regression that the runOnSynthesized contract exists to prevent).
   */
  readonly runOnSynthesized = false;
  private mentionPattern: RegExp;

  constructor(private opts: TelegramGroupMentionOptions) {
    // Telegram usernames are restricted to [A-Za-z0-9_], which contains no regex
    // metacharacters, so we don't strictly need to escape — but do it anyway as
    // a defense-in-depth measure in case a future caller passes a richer string.
    const escaped = opts.botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match `@username` only when not preceded or followed by another username
    // character. Case-insensitive because Telegram usernames are case-insensitive.
    this.mentionPattern = new RegExp(`(?:^|[^A-Za-z0-9_])@${escaped}(?:$|[^A-Za-z0-9_])`, 'i');
  }

  shouldHandle(msg: InboundMessage): FilterDecision {
    const raw = msg.raw as RawShape | null;
    const chatType = raw?.message?.chat?.type;
    if (chatType === 'private') return { type: 'pass' };

    const text = (msg.text ?? '').trim();
    if (text.startsWith('/')) return { type: 'pass' };
    if (this.mentionPattern.test(text)) return { type: 'pass' };

    const replyFrom = raw?.message?.reply_to_message?.from;
    if (
      replyFrom?.is_bot &&
      replyFrom.username?.toLowerCase() === this.opts.botUsername.toLowerCase()
    ) {
      return { type: 'pass' };
    }
    return { type: 'reject' };
  }
}
