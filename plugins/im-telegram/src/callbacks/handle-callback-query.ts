import type { ConversationMessageRecord, ConversationRepository } from '@goldpan/core/conversation';
import { errorMessage } from '@goldpan/core/errors';
import {
  type InboundMessage,
  resolveClarifyKeyedReplay,
  type SessionRef,
} from '@goldpan/im-runtime';
import type { Update } from 'grammy/types';
import type { ILogObj, Logger } from 'tslog';
import { createTranslator, type SupportedLanguage } from '../i18n/loader.js';
import type { TelegramReplyPayload } from '../types.js';
import {
  buildClarifyReplay,
  type ClarifyCallbackPayloadKeyed,
  parseClarifyCallback,
} from './clarify-callback.js';

export interface HandleCallbackQueryDeps {
  dispatch: (msg: InboundMessage) => Promise<void>;
  conversationRepo: ConversationRepository;
  sendReply: (ref: SessionRef, payload: TelegramReplyPayload) => Promise<void>;
  /**
   * Clear the inline keyboard on a stale clarify message. Kept as an injected
   * callback (rather than threading a full `grammy.Bot`) so unit tests can
   * assert the call without mocking the SDK surface. The adapter provides a
   * thin wrapper around `bot.api.editMessageReplyMarkup` in production.
   */
  editMessageReplyMarkup: (chatId: number | string, messageId: number) => Promise<void>;
  language: SupportedLanguage;
  logger: Logger<ILogObj>;
  accountId: string;
}

/**
 * Dedicated Telegram `callback_query` handler. Parses clarify callback data,
 * then routes by shape:
 *
 * - **Legacy** (`clarify:{convMsgId}:{optIdx}`, P3 in-flight keyboards) —
 *   walk the option **index** through `buildClarifyReplay`, dispatch a
 *   synthesized text message carrying the chosen label; the classifier
 *   re-judges intent. Kept verbatim for already-delivered keyboards.
 *
 * - **Keyed** (`clarify:{convMsgId}:{intentKey}[:{payload}]`, P4) — look up
 *   the originating user turn (the message immediately before the clarify
 *   assistant turn) and re-dispatch its raw text, but **with `forcedIntent`
 *   set to the tapped `intentKey`**, so the classifier is skipped entirely
 *   (Task 8 web `ClarifyResultCard` chip semantics, end-to-end).
 *
 * The `resolve_tracking_entity` chip is special-cased to a static "use the
 * web UI" reply: its payload is a JSON blob that easily blows past Telegram's
 * 64-byte `callback_data` ceiling, and the IM-side rendering for the tracking
 * subject picker is deferred to P5.
 */
export async function handleCallbackQuery(
  update: Update,
  deps: HandleCallbackQueryDeps,
): Promise<void> {
  const cb = update.callback_query;
  if (!cb?.message?.chat?.id || typeof cb.data !== 'string') {
    // Inline-mode callbacks (no chat) and malformed queries drop silently —
    // same "no chat → no action" stance polling.ts previously held.
    deps.logger.debug('telegram callback: missing chat id or data; dropping');
    return;
  }
  const parsed = parseClarifyCallback(cb.data);
  if (!parsed) {
    deps.logger.debug('telegram callback: foreign callback_data shape; dropping', {
      data: cb.data,
    });
    return;
  }
  const actor = {
    channelId: 'telegram',
    accountId: deps.accountId,
    chatId: String(cb.message.chat.id),
    userId: String(cb.from.id),
  };

  if (parsed.shape === 'legacy') {
    const replay = buildClarifyReplay(parsed, deps.conversationRepo, actor);
    if (replay.status === 'stale') {
      const t = createTranslator(deps.language);
      await deps.editMessageReplyMarkup(cb.message.chat.id, cb.message.message_id).catch((err) => {
        deps.logger.debug('clarify stale: editMessageReplyMarkup failed (ignored)', {
          err: errorMessage(err),
        });
      });
      await deps.sendReply(actor, { text: t('callback.expired', {}), format: 'plain' });
      return;
    }
    await deps.dispatch({
      channelId: 'telegram',
      accountId: deps.accountId,
      chatId: actor.chatId,
      userId: actor.userId,
      contentType: 'text',
      synthesized: true,
      sessionKeyOverride: replay.sessionKey,
      sessionRefOverride: replay.sessionRef,
      text: replay.text,
      platformMsgId: `clarify-replay:${parsed.conversationMessageId}:${parsed.optionIndex}`,
      raw: update,
      receivedAt: new Date(),
    });
    return;
  }

  await handleKeyedCallback(parsed, update, cb, actor, deps);
}

/**
 * P4 keyed-callback path. Extracted so the legacy branch stays a single read
 * of the existing happy path and reviewers can diff the new logic in isolation.
 */
async function handleKeyedCallback(
  parsed: ClarifyCallbackPayloadKeyed,
  update: Update,
  cb: NonNullable<Update['callback_query']>,
  actor: { channelId: string; accountId: string; chatId: string; userId: string },
  deps: HandleCallbackQueryDeps,
): Promise<void> {
  const t = createTranslator(deps.language);

  const replay = resolveClarifyKeyedReplay({
    repo: deps.conversationRepo,
    conversationMessageId: parsed.conversationMessageId,
    actor,
  });
  if (replay.status === 'stale') {
    await deps
      .editMessageReplyMarkup(cb.message?.chat?.id ?? actor.chatId, cb.message?.message_id ?? 0)
      .catch((err) => {
        deps.logger.debug('keyed clarify stale: editMessageReplyMarkup failed (ignored)', {
          err: errorMessage(err),
        });
      });
    await deps.sendReply(actor, { text: t('callback.expired', {}), format: 'plain' });
    return;
  }

  // tracking subject picker chip — IM not wired yet, surface the web instruction.
  // Keep the inline keyboard intact: the user may still want to tap *another*
  // chip (e.g. a non-tracking option) once they see this hint.
  if (parsed.intentKey === 'resolve_tracking_entity') {
    await deps.sendReply(actor, {
      text: t('callback.tracking_resolve_web_only', {}),
      format: 'plain',
    });
    return;
  }

  // Walk the conversation to find the user turn that triggered this clarify.
  // The clarify assistant turn is the row pointed at by `conversationMessageId`;
  // the originating user turn is the most-recent `role==='user'` row before it.
  // Using `loadConversationById` (full history) rather than `loadContext`
  // (windowed + buffered-skipping) keeps the lookup deterministic even when the
  // window has rolled past the original turn between clarify-render and tap.
  const conversation = deps.conversationRepo.loadConversationById(replay.conversationId);
  const messages = conversation?.messages ?? [];
  const clarifyIdx = messages.findIndex(
    (m: ConversationMessageRecord) => m.id === parsed.conversationMessageId,
  );
  const originalUser =
    clarifyIdx > 0
      ? [...messages.slice(0, clarifyIdx)]
          .reverse()
          .find((m: ConversationMessageRecord) => m.role === 'user')
      : undefined;
  if (!originalUser) {
    await deps.sendReply(actor, { text: t('callback.expired', {}), format: 'plain' });
    return;
  }

  // The chip is an explicit user pick — bypass classifier with forcedIntent
  // and carry the opaque payload through to the resolved intent plugin. The
  // shared keyed replay resolver verified that this actor is allowed to use
  // the clarify row and reconstructed the authoritative routing override.
  await deps.dispatch({
    channelId: 'telegram',
    accountId: deps.accountId,
    chatId: actor.chatId,
    userId: actor.userId,
    contentType: 'text',
    synthesized: true,
    sessionKeyOverride: replay.sessionKey,
    sessionRefOverride: replay.sessionRef,
    text: originalUser.content,
    forcedIntent: parsed.intentKey,
    ...(parsed.payload !== undefined ? { payload: parsed.payload } : {}),
    platformMsgId: `clarify-keyed:${parsed.conversationMessageId}:${parsed.intentKey}`,
    raw: update,
    receivedAt: new Date(),
  });
}
