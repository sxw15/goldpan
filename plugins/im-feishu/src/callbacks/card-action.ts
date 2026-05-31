import type { ConversationRepository } from '@goldpan/core/conversation';
import { type InboundMessage, resolveClarifyReplay, type SessionRef } from '@goldpan/im-runtime';
import type { ILogObj, Logger } from 'tslog';
import { parseCardActionEvent } from '../event/parse-card-action.js';
import type { SupportedLanguage } from '../i18n/loader.js';
import { renderError } from '../render/error.js';
import type { FeishuCardReply } from '../types.js';

export interface HandleCardActionDeps {
  dispatch: (msg: InboundMessage) => Promise<void>;
  conversationRepo: ConversationRepository;
  sendReply: (ref: SessionRef, payload: FeishuCardReply) => Promise<void>;
  language: SupportedLanguage;
  logger: Logger<ILogObj>;
  accountId: string;
}

/**
 * Handles Feishu `card.action.trigger` events. Mirrors the Telegram
 * `handleCallbackQuery` architecture:
 *
 *   - Validate payload shape (parseCardActionEvent).
 *   - Resolve via the shared `resolveClarifyReplay` helper — this runs
 *     replay authorization BEFORE inspecting `conversation_messages.metadata`,
 *     so cross-chat forged events never observe the private options array.
 *   - Either:
 *       · dispatch a synthesized text message (`synthesized: true`,
 *         deterministic replay id) carrying the tapped option label; OR
 *       · send a red "expired" card (all stale reasons collapse to the same
 *         user-visible surface; the underlying reason is logged for ops).
 *
 * Dedupe is handled by the dispatcher via the deterministic
 * `card-action-clarify:<msgId>:<idx>` platformMsgId. Telegram uses its own
 * `clarify-replay:` prefix; no cross-channel collision because dispatcher
 * dedupe is keyed by (channelId, accountId, chatId, platformMsgId).
 */
export async function handleCardActionEvent(
  raw: unknown,
  deps: HandleCardActionDeps,
): Promise<void> {
  const parsed = parseCardActionEvent(raw as Parameters<typeof parseCardActionEvent>[0]);
  if (!parsed) {
    deps.logger.debug('feishu card-action: invalid event payload; dropping');
    return;
  }
  const ref: SessionRef = {
    channelId: 'feishu',
    accountId: deps.accountId,
    chatId: parsed.chatId,
    userId: parsed.userOpenId,
  };

  const expiredReply = (): FeishuCardReply =>
    renderError(
      'callback.expired',
      {},
      {
        language: deps.language,
        sessionRef: ref,
        channelConfig: {},
        logger: deps.logger,
      },
    );

  const result = resolveClarifyReplay({
    repo: deps.conversationRepo,
    conversationMessageId: parsed.value.conversationMessageId,
    optionIndex: parsed.value.optionIndex,
    actor: {
      channelId: 'feishu',
      accountId: deps.accountId,
      chatId: parsed.chatId,
      userId: parsed.userOpenId,
    },
  });
  if (result.status === 'stale') {
    // `unauthorized` is a potential cross-chat replay attempt — surface at
    // warn so ops sees it in prod. The other stale reasons (missing /
    // archived / not_clarify / invalid_option_index) are routine lifecycle
    // outcomes and stay at debug.
    const logPayload = {
      reason: result.reason,
      conversationMessageId: parsed.value.conversationMessageId,
    };
    if (result.reason === 'unauthorized') {
      deps.logger.warn('feishu card-action: unauthorized replay attempt', logPayload);
    } else {
      deps.logger.debug('feishu card-action: stale', logPayload);
    }
    await deps.sendReply(ref, expiredReply());
    return;
  }

  await deps.dispatch({
    channelId: 'feishu',
    accountId: deps.accountId,
    chatId: parsed.chatId,
    userId: parsed.userOpenId,
    contentType: 'text',
    synthesized: true,
    sessionKeyOverride: result.sessionKey,
    sessionRefOverride: result.sessionRef,
    text: result.text,
    platformMsgId: `card-action-clarify:${parsed.value.conversationMessageId}:${parsed.value.optionIndex}`,
    raw,
    receivedAt: new Date(),
  });
}
