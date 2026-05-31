import type { CommandOverride } from '@goldpan/im-runtime';
import type { TelegramReplyPayload } from '../types.js';

/**
 * Telegram-local `/start` override. Replaces the former Layer A built-in.
 * Other channels (e.g. Feishu) that have no equivalent first-time-greeting
 * convention simply don't register this override.
 *
 * `noPersist: true` keeps the original built-in's stateless semantics: a
 * fresh `/start` should not manufacture a conversation containing only
 * the literal string "/start" (and so should not flip the immediately
 * following `/reset` from a no-op into "archive that synthetic
 * conversation"). The handler returns a localized welcome and exits —
 * no `ctx.conversation`, no history append.
 */
export const startCommandOverride: CommandOverride = {
  name: 'start',
  description: 'Show a welcome message.',
  noPersist: true,
  handle: async (_parsed, _msg, ctx): Promise<TelegramReplyPayload> => {
    const text =
      ctx.language === 'zh'
        ? '你好！我是你的知识助手。直接发消息提问，或用 /note 记录想法、/save <url> 收藏链接、/help 查看完整命令。'
        : "Hi! I'm your knowledge assistant. Send me a question, /note to capture a thought, " +
          '/save <url> to ingest a link, or /help for the full command list.';
    return { text, format: 'plain' };
  },
};
