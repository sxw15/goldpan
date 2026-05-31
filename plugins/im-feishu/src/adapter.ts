import type { ConversationRepository } from '@goldpan/core/conversation';
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
import { fetchBotOpenId } from './bot-identity.js';
import { handleCardActionEvent } from './callbacks/card-action.js';
import type { FeishuConfigInput } from './config.js';
import { parseFeishuConfig } from './config.js';
import { parseFeishuMessage } from './event/parse-message.js';
import { FeishuGroupMentionFilter } from './filters/group-mention.js';
import { FeishuUnsupportedContentFilter } from './filters/unsupported.js';
import { createTranslator, type SupportedLanguage } from './i18n/loader.js';
import { renderAction } from './render/action.js';
import { enforceCardSize } from './render/card-size.js';
import { renderClarify } from './render/clarify.js';
import { renderContent } from './render/content.js';
import { renderError } from './render/error.js';
import { renderHelpCard } from './render/help-card.js';
import { renderQuery } from './render/query.js';
import { renderResetCard } from './render/reset-card.js';
import { renderSubmit } from './render/submit.js';
import { fetchBotInfo } from './sdk/bot-info.js';
import { sendLarkMessage } from './sdk/message-send.js';
import { createEventDispatcher, createLarkClient, createWSClient } from './sdk/ws-factory.js';
import { SentMessageCache } from './sent-message-cache.js';
import { createFeishuTransport, type FeishuTransport } from './transport/ws-client.js';
import type { FeishuCardReply, FeishuReplyPayload, FeishuTextReply } from './types.js';

export interface FeishuAdapterDeps {
  conversationRepo: ConversationRepository;
}

/** Shape the Feishu adapter expects at `channelConfig`. */
export interface FeishuChannelConfig extends FeishuConfigInput {}
export type { FeishuConfigInput } from './config.js';

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

export function createFeishuAdapter(deps: FeishuAdapterDeps): ChannelAdapter {
  let descriptor: ChannelDescriptor = {
    channelId: 'feishu',
    state: 'stopped',
    inFlightCount: 0,
  };
  let activeSendReply: (ref: SessionRef, payload: FeishuReplyPayload) => Promise<void> =
    async () => {};
  let activeTransport: FeishuTransport | null = null;

  const adapter: ChannelAdapter = {
    channelId: 'feishu',
    capabilities: {
      inlineButtons: true,
      typingIndicator: false,
      richFormat: true,
      // Lark card JSON ceiling is ~30KB; the adapter's enforceCardSize step
      // soft-truncates before that (T11). The capability is advisory.
      maxMessageLength: 30000,
      images: false,
      lifecycleHooks: false,
    },
    defaultFilters: [],
    renderResult(
      result: IntentPluginResult,
      ctx: RenderContext,
    ): FeishuCardReply | FeishuCardReply[] {
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
          return renderAction({ type: 'action', message: renderCoreResultText(result, ctx) }, ctx);
        case 'clarify':
          return renderClarify(result, ctx);
        default: {
          return renderError(
            'render.unsupported_result_type',
            { type: (result as { type: string }).type },
            ctx,
          );
        }
      }
    },
    renderError(code, vars, ctx) {
      return renderError(code, vars, ctx);
    },
    buildSystemReply(text: string): FeishuTextReply {
      return { kind: 'text', text };
    },
    buildHelpReply(data) {
      return renderHelpCard(data);
    },
    buildResetReply(data) {
      return renderResetCard(data);
    },
    async start(startDeps: ChannelStartDeps) {
      const cfgInput = startDeps.channelConfig as FeishuChannelConfig;
      const cfg = parseFeishuConfig(cfgInput);
      const language: SupportedLanguage = startDeps.language;
      const translator = createTranslator(language);

      descriptor = { channelId: 'feishu', state: 'starting', inFlightCount: 0 };

      const domainUrl =
        cfg.domain === 'larksuite.com' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';

      // Core SDK Client for REST calls (bot identity, message send).
      // Factory lives in src/sdk/ws-factory.ts per plan: adapter.ts owns
      // composition, sdk/* owns every `new lark.*` construction.
      const sdkClient = createLarkClient({
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        domain: domainUrl,
      });

      // Resolve bot identity first — fail loud if it doesn't work (see
      // bot-identity.ts for rationale). SDK call shape lives in
      // src/sdk/bot-info.ts so this line never changes if Lark moves the API.
      const botOpenId = await fetchBotOpenId({
        fetcher: () => fetchBotInfo(sdkClient),
        logger: startDeps.logger,
      });

      const sentCache = new SentMessageCache({ maxPerChat: 32 });

      activeSendReply = async (ref, payload) => {
        // T11: interactive cards may exceed Lark's 30KB hard limit. Run
        // them through the size enforcer first — it truncates the largest
        // text block down to 25KB, or falls back to a plain-text reply in
        // the pathological case where even a minimal card would overflow.
        // The call preserves the SDK-wrapper boundary (sendLarkMessage is
        // still the single call site) and the sentCache.markSent contract
        // that backs FeishuGroupMentionFilter's reply-to-bot branch.
        const safe: FeishuReplyPayload =
          payload.kind === 'interactive'
            ? enforceCardSize(payload, { logger: startDeps.logger, sessionKey: ref.chatId })
            : payload;
        const msgType = safe.kind === 'interactive' ? 'interactive' : 'text';
        const content =
          safe.kind === 'interactive'
            ? JSON.stringify(safe.card)
            : JSON.stringify({ text: safe.text });
        const result = await sendLarkMessage(sdkClient, {
          chatId: ref.chatId,
          ...(ref.threadId !== undefined ? { parentId: ref.threadId } : {}),
          msgType,
          content,
        });
        if (result.messageId) sentCache.markSent(ref.chatId, result.messageId);
      };
      startDeps.installSendReply((ref, payload) =>
        activeSendReply(ref, payload as FeishuReplyPayload),
      );

      adapter.defaultFilters = [
        new FeishuGroupMentionFilter({ botOpenId, sentMessageCache: sentCache }),
        new FeishuUnsupportedContentFilter({ translator }),
      ];

      const transport = await createFeishuTransport({
        // SDK call shapes are concentrated in src/sdk/* (per-plan): if Lark
        // changes the WSClient or EventDispatcher constructor, only those
        // files need editing. The adapter never sees `new lark.WSClient(...)`.
        wsClientFactory: () =>
          createWSClient({
            appId: cfg.appId,
            appSecret: cfg.appSecret,
            domain: domainUrl,
          }),
        eventDispatcherFactory: () =>
          createEventDispatcher({
            ...(cfg.encryptKey ? { encryptKey: cfg.encryptKey } : {}),
          }),
        onMessageEvent: async (event) => {
          const inbound = parseFeishuMessage(event as Parameters<typeof parseFeishuMessage>[0], {
            accountId: cfg.appId,
          });
          if (!inbound) return;
          await startDeps.dispatch(inbound);
        },
        onCardActionEvent: async (event) => {
          await handleCardActionEvent(event, {
            dispatch: startDeps.dispatch,
            conversationRepo: deps.conversationRepo,
            sendReply: (ref, payload) => activeSendReply(ref, payload),
            language,
            logger: startDeps.logger,
            accountId: cfg.appId,
          });
        },
        logger: startDeps.logger,
      });
      activeTransport = transport;
      await transport.start();

      descriptor = {
        channelId: 'feishu',
        state: 'running',
        inFlightCount: 0,
        account: { id: cfg.appId, displayName: `Feishu ${cfg.appId}` },
      };
    },
    async shutdown() {
      descriptor = { ...descriptor, state: 'shutting_down' };
      try {
        await activeTransport?.shutdown();
      } finally {
        activeTransport = null;
        descriptor = { ...descriptor, state: 'stopped', inFlightCount: 0 };
      }
    },
    describe() {
      return descriptor;
    },
  };

  return adapter;
}
