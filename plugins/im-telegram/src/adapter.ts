import type { ConversationRepository } from '@goldpan/core/conversation';
import { errorMessage } from '@goldpan/core/errors';
import {
  type Language as CoreLanguage,
  createTranslator as createCoreTranslator,
} from '@goldpan/core/i18n';
import type { IntentPluginResult } from '@goldpan/core/plugins';
import type {
  ChannelAdapter,
  ChannelDescriptor,
  ChannelStartDeps,
  RenderContext,
  SessionRef,
} from '@goldpan/im-runtime';
import { handleCallbackQuery } from './callbacks/handle-callback-query.js';
import { splitForTelegram } from './chunking/split-4096.js';
import { startCommandOverride } from './commands/start.js';
import { TelegramAllowlistFilter } from './filters/allowlist.js';
import { TelegramGroupMentionFilter } from './filters/group-mention.js';
import { TelegramUnsupportedFilter } from './filters/unsupported.js';
import { createTranslator, type SupportedLanguage } from './i18n/loader.js';
import { createTypingLifecycle } from './lifecycle/typing.js';
import { renderAction } from './render/action.js';
import { renderClarify } from './render/clarify.js';
import { renderContent } from './render/content.js';
import { renderError } from './render/error.js';
import { formatHelpText } from './render/help-text.js';
import { renderQuery } from './render/query.js';
import { formatResetText } from './render/reset-text.js';
import { renderSubmit } from './render/submit.js';
import { htmlToPlain, isTelegramParseEntitiesError } from './transport/html-fallback.js';
import { createTelegramTransport, type TelegramTransport } from './transport/polling.js';
import { withTelegramRetryAfter } from './transport/retry-after.js';
import type { TelegramReplyPayload } from './types.js';

export interface TelegramAdapterDeps {
  conversationRepo: ConversationRepository;
}

/** Shape the Telegram adapter expects at `channelConfig`. */
export interface TelegramChannelConfig {
  allowedChatIds?: string[];
}

function renderCoreResultText(
  result: Extract<IntentPluginResult, { type: 'note' | 'tracking_pending' }>,
  ctx: RenderContext,
): string {
  const t = createCoreTranslator((ctx.language as CoreLanguage) ?? 'en').t;
  if (result.type === 'note') {
    return t('intent_note.saved_assistant_text', { noteId: result.detail.id });
  }
  const key =
    result.reasonKey === 'waiting_pipeline'
      ? 'intent_tracking.pending_pipeline_assistant_text'
      : 'intent_tracking.pending_multi_entity_assistant_text';
  return t(key);
}

export function createTelegramAdapter(deps: TelegramAdapterDeps): ChannelAdapter {
  let transport: TelegramTransport | null = null;
  let descriptor: ChannelDescriptor = {
    channelId: 'telegram',
    state: 'stopped',
    inFlightCount: 0,
  };
  let inFlight = 0;
  let typingLifecycle: ReturnType<typeof createTypingLifecycle> | null = null;
  let activeSendReply: (ref: SessionRef, payload: TelegramReplyPayload) => Promise<void> =
    async () => {};

  const adapter: ChannelAdapter = {
    channelId: 'telegram',
    capabilities: {
      inlineButtons: true,
      typingIndicator: true,
      richFormat: true,
      maxMessageLength: 4096,
      images: false,
      lifecycleHooks: true,
    },
    defaultFilters: [],
    commandOverrides: [startCommandOverride],
    renderResult(result: IntentPluginResult, ctx: RenderContext) {
      switch (result.type) {
        case 'query':
          return renderQuery(result, ctx);
        case 'submit':
          return renderSubmit(result, ctx);
        case 'content':
          return renderContent(result, ctx);
        case 'action':
          return renderAction(result, ctx);
        case 'note':
        case 'tracking_pending':
          return { text: renderCoreResultText(result, ctx), format: 'plain' as const };
        case 'clarify': {
          const conversationMessageId = ctx.assistantMessageId ?? 0;
          return renderClarify(result, ctx, { conversationMessageId });
        }
        default: {
          // Defensive fallback: localized via the same i18n table as filters/errors so
          // operators see a consistent surface even for impossible-in-spec result types.
          const t = createTranslator((ctx.language as SupportedLanguage) ?? 'en');
          const unknownType = (result as { type: string }).type;
          return {
            text: t('render.unsupported_result_type', { type: unknownType }),
            format: 'plain' as const,
          };
        }
      }
    },
    renderError(code: string, vars: Record<string, unknown>, ctx: RenderContext) {
      return renderError(code, vars, ctx);
    },
    buildSystemReply(text: string): TelegramReplyPayload {
      return { text, format: 'plain' };
    },
    buildHelpReply(data): TelegramReplyPayload {
      return { text: formatHelpText(data), format: 'plain' };
    },
    buildResetReply(data): TelegramReplyPayload {
      return { text: formatResetText(data), format: 'plain' };
    },
    async start(startDeps: ChannelStartDeps) {
      const token = startDeps.secrets.botToken;
      if (!token) throw new Error('Telegram adapter: secrets.botToken is required');

      descriptor = {
        channelId: 'telegram',
        state: 'starting',
        inFlightCount: 0,
      };

      const cfg = startDeps.channelConfig as TelegramChannelConfig;
      // Language sourced from `ChannelStartDeps.language` (runtime forwards
      // `IMRuntimeDeps.config.language`). Keep one resolved value so the
      // callback-expired handler and the filter setup share a single source
      // of truth — and so all surfaces in this channel use the same i18n table.
      const language: SupportedLanguage = startDeps.language;
      const t = createTranslator(language);

      transport = await createTelegramTransport({
        token,
        logger: startDeps.logger,
        signal: startDeps.signal,
        dispatch: startDeps.dispatch,
        onCallbackQuery: async (update) => {
          if (!transport) return;
          await handleCallbackQuery(update, {
            dispatch: startDeps.dispatch,
            conversationRepo: deps.conversationRepo,
            sendReply: (ref, payload) => activeSendReply(ref, payload),
            editMessageReplyMarkup: async (chatId, messageId) => {
              await transport?.bot.api.editMessageReplyMarkup(chatId, messageId, {
                reply_markup: { inline_keyboard: [] },
              });
            },
            language,
            logger: startDeps.logger,
            accountId: transport.accountId,
          });
        },
        onPollingError: (error) => {
          descriptor = {
            ...descriptor,
            state: 'error',
            lastErrorAt: new Date(),
            lastErrorMessage: error.message,
          };
        },
      });

      const { botUsername, accountId } = transport;
      startDeps.configureCommandParser({ botUsername });

      const allowedChatIds = (cfg.allowedChatIds ?? []).filter(Boolean);
      adapter.defaultFilters = [
        new TelegramAllowlistFilter({ allowedChatIds }),
        new TelegramGroupMentionFilter({ botUsername }),
        new TelegramUnsupportedFilter({ message: t('filter.unsupported_content', {}) }),
      ];

      typingLifecycle = createTypingLifecycle(transport.bot);
      adapter.lifecycle = {
        onProcessingStart: (ctx) => {
          inFlight += 1;
          descriptor = { ...descriptor, inFlightCount: inFlight };
          return typingLifecycle?.onProcessingStart?.(ctx);
        },
        onProcessingEnd: (ctx, result) => {
          inFlight = Math.max(0, inFlight - 1);
          descriptor = { ...descriptor, inFlightCount: inFlight };
          return typingLifecycle?.onProcessingEnd?.(ctx, result);
        },
      };

      activeSendReply = async (ref, payload) => {
        const chunks = splitForTelegram(payload.text, adapter.capabilities.maxMessageLength);
        const wantsHtml = payload.format === 'html';
        for (let i = 0; i < chunks.length; i++) {
          const isLast = i === chunks.length - 1;
          const baseOpts = {
            reply_markup:
              isLast && payload.inlineButtons
                ? {
                    inline_keyboard: payload.inlineButtons.map((row) =>
                      row.map((b) => ({ text: b.label, callback_data: b.callbackData })),
                    ),
                  }
                : undefined,
            link_preview_options: { is_disabled: true as const },
          };
          await withTelegramRetryAfter(
            async () => {
              try {
                return await transport?.bot.api.sendMessage(ref.chatId, chunks[i], {
                  ...baseOpts,
                  parse_mode: wantsHtml ? 'HTML' : undefined,
                });
              } catch (err) {
                // Telegram rejected our HTML (e.g. sanitizer produced a tag it doesn't support,
                // or a markdown edge case slipped past markdownToTelegramHtml). Strip tags and
                // resend as plain text so the user still sees the answer instead of an error
                // bubble — and doesn't see literal `<i>`/`<a>` markup in the reply.
                if (wantsHtml && isTelegramParseEntitiesError(err)) {
                  startDeps.logger.warn('telegram rejected HTML; retrying as plain text', {
                    description:
                      (err as { description?: unknown }).description ?? errorMessage(err),
                  });
                  return await transport?.bot.api.sendMessage(
                    ref.chatId,
                    htmlToPlain(chunks[i]),
                    baseOpts,
                  );
                }
                throw err;
              }
            },
            {
              logger: startDeps.logger,
              signal: startDeps.signal,
            },
          );
        }
      };
      startDeps.installSendReply((ref, payload) =>
        activeSendReply(ref, payload as TelegramReplyPayload),
      );

      await transport.start();
      descriptor = {
        channelId: 'telegram',
        state: 'running',
        inFlightCount: inFlight,
        account: { id: accountId, displayName: botUsername },
      };
    },
    async shutdown() {
      descriptor = { ...descriptor, state: 'shutting_down' };
      typingLifecycle?.stopAll();
      await transport?.stop();
      transport = null;
      descriptor = { ...descriptor, state: 'stopped', inFlightCount: 0 };
    },
    describe() {
      return descriptor;
    },
  };

  return adapter;
}
