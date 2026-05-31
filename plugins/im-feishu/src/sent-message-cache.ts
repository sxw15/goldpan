export interface SentMessageCacheOptions {
  /**
   * Max recent message ids tracked per chat. 32 covers the "user replied to
   * bot's last 1-2 messages" common case without unbounded memory growth.
   */
  maxPerChat?: number;
}

/**
 * In-memory bounded cache of "messages this bot recently sent in each chat".
 * Used by `FeishuGroupMentionFilter` for reply-to-bot detection, avoiding a
 * cross-cutting Layer A refactor of `installSendReply`'s signature.
 *
 * Lifetime: process-local, lost on restart — reply-to-bot detection silently
 * degrades to "rejected" for a few minutes after restart until the bot sends
 * fresh messages into each active chat. This is acceptable; the alternative
 * (persisting every sent message id) would require extending the
 * ConversationRepository contract just to serve a Feishu-internal need.
 *
 * Concurrency: not thread-safe. Node.js is single-threaded within a given
 * event loop, so per-cache mutations happen sequentially.
 */
export class SentMessageCache {
  private readonly maxPerChat: number;
  private readonly perChat = new Map<string, { fifo: string[]; set: Set<string> }>();

  constructor(opts: SentMessageCacheOptions = {}) {
    this.maxPerChat = opts.maxPerChat ?? 32;
  }

  markSent(chatId: string, messageId: string): void {
    let entry = this.perChat.get(chatId);
    if (!entry) {
      entry = { fifo: [], set: new Set() };
      this.perChat.set(chatId, entry);
    }
    if (entry.set.has(messageId)) return;
    entry.fifo.push(messageId);
    entry.set.add(messageId);
    while (entry.fifo.length > this.maxPerChat) {
      const evicted = entry.fifo.shift();
      // Length check above guarantees a non-empty array, but the type system
      // cannot narrow `Array.shift()` past `T | undefined`.
      if (evicted === undefined) break;
      entry.set.delete(evicted);
    }
  }

  wasSent(chatId: string, messageId: string): boolean {
    return this.perChat.get(chatId)?.set.has(messageId) ?? false;
  }
}
