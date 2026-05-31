import type { ChannelLifecycleHooks, InboundStartContext } from '@goldpan/im-runtime';
import type { Bot } from 'grammy';

const HEARTBEAT_MS = 4_000;

export function createTypingLifecycle(bot: Bot): ChannelLifecycleHooks & {
  /** Stops every active heartbeat (used during shutdown). */
  stopAll(): void;
} {
  const timers = new Map<string, NodeJS.Timeout>();

  const send = (chatId: string) => {
    bot.api.sendChatAction(chatId, 'typing').catch(() => undefined);
  };

  return {
    onProcessingStart(ctx: InboundStartContext) {
      send(ctx.sessionRef.chatId);
      const t = setInterval(() => send(ctx.sessionRef.chatId), HEARTBEAT_MS);
      timers.set(ctx.sessionKey, t);
    },
    onProcessingEnd(ctx) {
      const t = timers.get(ctx.sessionKey);
      if (t) {
        clearInterval(t);
        timers.delete(ctx.sessionKey);
      }
    },
    stopAll() {
      for (const t of timers.values()) clearInterval(t);
      timers.clear();
    },
  };
}
