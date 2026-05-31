import { SqliteConversationRepository } from '@goldpan/core';
import type { ChannelAdapter, InboundMessage } from '@goldpan/im-runtime';
import {
  CommandParser,
  ConversationStore,
  defaultCommands,
  InboundDispatcher,
  MessageDedupe,
  SessionRouter,
} from '@goldpan/im-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleCardActionEvent } from '../../src/callbacks/card-action.js';
import { FeishuGroupMentionFilter } from '../../src/filters/group-mention.js';
import { FeishuUnsupportedContentFilter } from '../../src/filters/unsupported.js';
import { createTranslator } from '../../src/i18n/loader.js';
import { SentMessageCache } from '../../src/sent-message-cache.js';
import { createTestDB, type TestDB } from '../helpers/test-db.js';

/**
 * End-to-end integration: FeishuGroupMentionFilter would reject a raw "Yes"
 * text in a group chat (no mention, no `/`, no reply-to-bot). But a
 * card-action tap produces a `synthesized: true` re-dispatch, which the
 * dispatcher MUST route past all filters and into handleInput.
 *
 * This test wires the REAL InboundDispatcher + REAL Feishu filters + REAL
 * handleCardActionEvent against a real SQLite conversation repo — no mock
 * seams on the filter-skip code path. It's the regression guard for the
 * Phase 1 group-chat clarify latent bug at the seam where all three pieces
 * meet (the in-isolation unit tests prove each piece; this proves the wiring).
 */
describe('Feishu card-action → synthesized dispatch → filter-skip (integration)', () => {
  let testDb: TestDB;
  afterEach(() => testDb?.cleanup());

  it('a Lark card-action tap in a group chat dispatches to handleInput even though the group filter would normally reject', async () => {
    testDb = createTestDB();
    const repo = new SqliteConversationRepository(testDb.db);
    const store = new ConversationStore({ repo, defaultWindowSize: 8 });
    const dedupe = new MessageDedupe(testDb.db);
    const router = new SessionRouter({ routingMode: 'per_chat' });
    const parser = new CommandParser({});

    // Seed: prior assistant clarify message in the group chat, stored under
    // its sessionKey so the card-action handler can look it up.
    const sessionKey = 'feishu:cli_x:oc_group';
    const conv = store.loadOrCreate(sessionKey, 'feishu');
    store.appendUserTurn(conv.conversationId, 'which fruit?');
    const assistantTurn = store.appendAssistantTurn(conv.conversationId, {
      type: 'clarify',
      question: 'Apple or Banana?',
      options: ['Apple', 'Banana'],
    });
    const conversationMessageId = assistantTurn.id;

    // REAL Feishu filters — group-mention would reject a raw "Apple" because
    // the message has no mention of the bot and doesn't start with `/`.
    const sentCache = new SentMessageCache();
    const groupFilter = new FeishuGroupMentionFilter({
      botOpenId: 'ou_bot',
      sentMessageCache: sentCache,
    });
    const unsupportedFilter = new FeishuUnsupportedContentFilter({
      translator: createTranslator('en'),
    });
    const groupFilterSpy = vi.spyOn(groupFilter, 'shouldHandle');

    // Build a real ChannelAdapter for dispatcher's `channel` slot. The
    // filter array is the real Feishu default filters we just constructed.
    const channel: ChannelAdapter = {
      channelId: 'feishu',
      capabilities: {
        inlineButtons: true,
        typingIndicator: false,
        richFormat: true,
        maxMessageLength: 30000,
        images: false,
        lifecycleHooks: false,
      },
      defaultFilters: [groupFilter, unsupportedFilter],
      renderResult: vi.fn(() => ({ kind: 'text', text: 'rendered' })),
      renderError: vi.fn(() => ({ kind: 'text', text: 'err' })),
      buildSystemReply: vi.fn((text: string) => ({ kind: 'text', text })),
      buildHelpReply: vi.fn(() => ({ kind: 'text', text: 'help' })),
      buildResetReply: vi.fn(() => ({ kind: 'text', text: 'reset' })),
      start: vi.fn(),
      shutdown: vi.fn(),
      describe: vi.fn(() => ({
        channelId: 'feishu',
        state: 'running' as const,
        inFlightCount: 0,
      })),
    };

    const handleInput = vi.fn(async () => ({
      type: 'content',
      text: 'ok',
      format: 'text',
    }));

    const sent: unknown[] = [];
    const sendReply = vi.fn(async (_ref: unknown, payload: unknown) => {
      sent.push(payload);
    });

    const dispatcher = new InboundDispatcher({
      channel,
      router,
      parser,
      dedupe,
      store,
      conversationRepo: repo,
      handleInput: handleInput as never,
      sendReply,
      overrideCommands: defaultCommands,
      intentDeclarations: [],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as never,
      renderContextBuilder: (ref) => ({
        language: 'en',
        sessionRef: ref,
        channelConfig: {},
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        } as never,
      }),
      language: 'en',
    });

    // BASELINE: a raw "Apple" text in the group chat would be rejected by
    // the group filter. Verify that first so the test makes the assertion
    // meaningful — otherwise the "filter skipped" claim could be vacuous
    // (filter might just always pass).
    const rawGroupMessage: InboundMessage = {
      channelId: 'feishu',
      accountId: 'cli_x',
      chatId: 'oc_group',
      userId: 'ou_user',
      platformMsgId: 'raw-1',
      text: 'Apple',
      contentType: 'text',
      raw: { event: { message: { chat_type: 'group', mentions: [] } } },
      receivedAt: new Date(),
    };
    await dispatcher.dispatch(rawGroupMessage);
    expect(groupFilterSpy).toHaveBeenCalledTimes(1);
    expect(handleInput).not.toHaveBeenCalled(); // filter rejected

    groupFilterSpy.mockClear();

    // NOW: fire the card-action event. handleCardActionEvent →
    // resolveClarifyReplay → dispatcher.dispatch with synthesized=true →
    // filter-skip → handleInput runs with text='Apple'.
    await handleCardActionEvent(
      {
        event: {
          operator: { open_id: 'ou_user' },
          chat_id: 'oc_group',
          action: {
            value: {
              action: 'clarify',
              conversationMessageId,
              optionIndex: 0,
            },
          },
        },
      },
      {
        dispatch: (msg) => dispatcher.dispatch(msg),
        conversationRepo: repo,
        sendReply: async (_ref, payload) => {
          sent.push(payload);
        },
        language: 'en',
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        } as never,
        accountId: 'cli_x',
      },
    );

    // CRITICAL ASSERTIONS:
    //  (1) The group filter was NOT called for the synthesized dispatch
    //      (dispatcher.dispatch with synthesized=true skips filters).
    expect(groupFilterSpy).not.toHaveBeenCalled();
    //  (2) handleInput was invoked — proof that the synthesized message
    //      made it past the filter chain and into the pipeline.
    expect(handleInput).toHaveBeenCalledTimes(1);
    const handleInputCall = handleInput.mock.calls[0][0] as { input: string };
    expect(handleInputCall.input).toBe('Apple');
  });

  it('dedupe still fires on a double-tap (deterministic replay id + synthesized=true keeps dedupe)', async () => {
    testDb = createTestDB();
    const repo = new SqliteConversationRepository(testDb.db);
    const store = new ConversationStore({ repo, defaultWindowSize: 8 });
    const dedupe = new MessageDedupe(testDb.db);
    const router = new SessionRouter({ routingMode: 'per_chat' });
    const parser = new CommandParser({});

    const sessionKey = 'feishu:cli_x:oc_group';
    const conv = store.loadOrCreate(sessionKey, 'feishu');
    store.appendUserTurn(conv.conversationId, 'pick');
    const assistantTurn = store.appendAssistantTurn(conv.conversationId, {
      type: 'clarify',
      question: 'A or B?',
      options: ['A', 'B'],
    });
    const conversationMessageId = assistantTurn.id;

    const groupFilter = new FeishuGroupMentionFilter({
      botOpenId: 'ou_bot',
      sentMessageCache: new SentMessageCache(),
    });
    const channel: ChannelAdapter = {
      channelId: 'feishu',
      capabilities: {
        inlineButtons: true,
        typingIndicator: false,
        richFormat: true,
        maxMessageLength: 30000,
        images: false,
        lifecycleHooks: false,
      },
      defaultFilters: [groupFilter],
      renderResult: vi.fn(() => ({ kind: 'text', text: 'rendered' })),
      renderError: vi.fn(() => ({ kind: 'text', text: 'err' })),
      buildSystemReply: vi.fn((text: string) => ({ kind: 'text', text })),
      buildHelpReply: vi.fn(() => ({ kind: 'text', text: 'help' })),
      buildResetReply: vi.fn(() => ({ kind: 'text', text: 'reset' })),
      start: vi.fn(),
      shutdown: vi.fn(),
      describe: vi.fn(() => ({
        channelId: 'feishu',
        state: 'running' as const,
        inFlightCount: 0,
      })),
    };
    const handleInput = vi.fn(async () => ({
      type: 'content',
      text: 'ok',
      format: 'text',
    }));
    const dispatcher = new InboundDispatcher({
      channel,
      router,
      parser,
      dedupe,
      store,
      conversationRepo: repo,
      handleInput: handleInput as never,
      sendReply: vi.fn(),
      overrideCommands: defaultCommands,
      intentDeclarations: [],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as never,
      renderContextBuilder: (ref) => ({
        language: 'en',
        sessionRef: ref,
        channelConfig: {},
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        } as never,
      }),
      language: 'en',
    });

    const firePayload = () =>
      handleCardActionEvent(
        {
          event: {
            operator: { open_id: 'ou_user' },
            chat_id: 'oc_group',
            action: {
              value: { action: 'clarify', conversationMessageId, optionIndex: 0 },
            },
          },
        },
        {
          dispatch: (msg) => dispatcher.dispatch(msg),
          conversationRepo: repo,
          sendReply: vi.fn(),
          language: 'en',
          logger: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
          } as never,
          accountId: 'cli_x',
        },
      );

    await firePayload();
    await firePayload();
    // Both taps synthesize the SAME platformMsgId `card-action-clarify:<id>:0`.
    // Dispatcher dedupe (im_messages_seen) drops the second — handleInput
    // runs only once. This is the "keep dedupe" half of the synthesized
    // contract, verified at the Feishu wiring level.
    expect(handleInput).toHaveBeenCalledTimes(1);
  });
});
