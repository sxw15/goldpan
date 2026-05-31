import type { InboundMessage } from '@goldpan/im-runtime';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import type { ILogObj, Logger } from 'tslog';

export interface PollingOptions {
  token: string;
  logger: Logger<ILogObj>;
  signal: AbortSignal;
  dispatch(msg: InboundMessage): Promise<void>;
  /**
   * Called when grammy receives a `callback_query` update. The handler owns
   * any business logic (parsing, conversation lookup, synthesized
   * re-dispatch). The polling layer only acknowledges the query with
   * `answerCallbackQuery` and routes the raw update through.
   *
   * Replaces Phase 1's `dispatch(msg, contentType: 'callback')` path — Layer A
   * no longer sees a 'callback' content type.
   */
  onCallbackQuery?(update: Update): Promise<void>;
  onPollingError?(error: Error): void;
}

export interface TelegramTransport {
  bot: Bot;
  botUsername: string;
  accountId: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Translates a non-callback message `Update` into an `InboundMessage`.
 *
 * Returns null for:
 *   - non-message updates (edited_message, channel_post, …) — the polling
 *     layer only subscribes to `message` + `callback_query`, but this guards
 *     against the caller passing any other shape.
 */
export function translateMessageUpdate(
  update: Update,
  ctx: { accountId: string },
): InboundMessage | null {
  const m = update.message;
  if (!m) return null;
  // animation/video_note → 'video' (both MP4); audio (music) → 'voice';
  // sticker/other unknown types fall through to 'other'.
  const contentType: InboundMessage['contentType'] = m.text
    ? 'text'
    : m.photo
      ? 'image'
      : m.voice || m.audio
        ? 'voice'
        : m.video || m.animation || m.video_note
          ? 'video'
          : m.document
            ? 'file'
            : 'other';
  return {
    channelId: 'telegram',
    accountId: ctx.accountId,
    chatId: String(m.chat.id),
    userId: String(m.from?.id ?? m.chat.id),
    platformMsgId: String(m.message_id),
    ...(m.text !== undefined ? { text: m.text } : {}),
    contentType,
    raw: update,
    receivedAt: new Date(m.date * 1000),
  };
}

export async function createTelegramTransport(opts: PollingOptions): Promise<TelegramTransport> {
  const bot = new Bot(opts.token);
  const me = await bot.api.getMe();
  const botUsername = me.username;
  const accountId = String(me.id);
  let runPromise: Promise<void> | null = null;

  bot.on('message', async (ctx) => {
    const msg = translateMessageUpdate(ctx.update, { accountId });
    if (!msg) return;
    try {
      await opts.dispatch(msg);
    } catch (err) {
      opts.logger.error('telegram dispatch error', err);
    }
  });
  bot.on('callback_query', async (ctx) => {
    // Telegram expects callback queries to be answered promptly; otherwise
    // the button spinner can stick and the query may expire before the
    // follow-up finishes.
    await ctx.answerCallbackQuery().catch(() => undefined);
    if (!opts.onCallbackQuery) {
      opts.logger.debug('telegram: callback_query received with no handler installed');
      return;
    }
    try {
      await opts.onCallbackQuery(ctx.update);
    } catch (err) {
      opts.logger.error('telegram callback handler error', err);
    }
  });

  return {
    bot,
    botUsername,
    accountId,
    async start() {
      await new Promise<void>((resolve, reject) => {
        let settled = false;

        const normalizeError = (err: unknown) =>
          err instanceof Error ? err : new Error(String(err));

        opts.signal.addEventListener('abort', () => {
          bot.stop().catch((err) => opts.logger.warn('grammy stop error', err));
          if (!settled) {
            settled = true;
            reject(new Error('Telegram polling aborted during startup'));
          }
        });

        runPromise = bot
          .start({
            allowed_updates: ['message', 'callback_query'],
            onStart: () => {
              if (settled) return;
              settled = true;
              resolve();
            },
          })
          .catch((err) => {
            const error = normalizeError(err);
            opts.logger.error('grammy polling crashed', error);
            if (!settled) {
              settled = true;
              reject(error);
              return;
            }
            opts.onPollingError?.(error);
          });
      });
    },
    async stop() {
      await bot.stop();
      await runPromise?.catch(() => undefined);
    },
  };
}
