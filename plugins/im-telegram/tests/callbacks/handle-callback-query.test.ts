import type { InboundMessage } from '@goldpan/im-runtime';
import { describe, expect, it, vi } from 'vitest';
import { handleCallbackQuery } from '../../src/callbacks/handle-callback-query.js';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

const baseDeps = (overrides: Partial<Parameters<typeof handleCallbackQuery>[1]> = {}) => ({
  dispatch: vi.fn(async () => {}),
  conversationRepo: {
    getMessageById: vi.fn().mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'telegram:bot:-100',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'which?',
      metadata: { resultType: 'clarify', options: ['Yes', 'No'] },
      createdAt: new Date(),
    }),
    loadConversationById: vi.fn().mockReturnValue({
      id: 1,
      sessionKey: 'telegram:bot:-100',
      channelId: 'telegram',
      archivedAt: null,
      messages: [
        { id: 40, role: 'user', content: 'track Apple stock', metadata: {}, createdAt: 0 },
        { id: 42, role: 'assistant', content: 'which?', metadata: {}, createdAt: 1 },
      ],
    }),
  } as never,
  sendReply: vi.fn(async () => {}),
  editMessageReplyMarkup: vi.fn(async () => {}),
  language: 'en' as const,
  logger: stubLogger,
  accountId: 'bot',
  ...overrides,
});

describe('handleCallbackQuery (legacy)', () => {
  it('valid clarify: dispatches synthesized text msg with deterministic replay id', async () => {
    const deps = baseDeps();
    await handleCallbackQuery(
      {
        callback_query: {
          id: 'cb-1',
          from: { id: 999 },
          message: { chat: { id: -100 }, message_id: 555, date: 1000 },
          data: 'clarify:42:1',
        },
      } as never,
      deps,
    );
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    const dispatched = deps.dispatch.mock.calls[0][0] as InboundMessage;
    expect(dispatched.contentType).toBe('text');
    expect(dispatched.synthesized).toBe(true);
    expect(dispatched.text).toBe('No');
    expect(dispatched.platformMsgId).toBe('clarify-replay:42:1');
    expect(dispatched.sessionKeyOverride).toBe('telegram:bot:-100');
    expect(dispatched.sessionRefOverride).toEqual({
      channelId: 'telegram',
      accountId: 'bot',
      chatId: '-100',
      userId: '999',
    });
    expect(dispatched.forcedIntent).toBeUndefined();
  });

  it('stale (archived): sends "expired" reply, removes inline keyboard, does NOT dispatch', async () => {
    const deps = baseDeps();
    deps.conversationRepo.getMessageById = vi.fn().mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'telegram:bot:-100',
      conversationArchivedAt: new Date(),
      role: 'assistant',
      content: 'which?',
      metadata: { resultType: 'clarify', options: ['Yes', 'No'] },
      createdAt: new Date(),
    });
    await handleCallbackQuery(
      {
        callback_query: {
          id: 'cb-1',
          from: { id: 999 },
          message: { chat: { id: -100 }, message_id: 555, date: 1000 },
          data: 'clarify:42:1',
        },
      } as never,
      deps,
    );
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.sendReply).toHaveBeenCalledTimes(1);
    expect(deps.editMessageReplyMarkup).toHaveBeenCalledWith(-100, 555);
  });

  it('foreign callback_data shape: drops silently (no dispatch, no reply)', async () => {
    const deps = baseDeps();
    await handleCallbackQuery(
      {
        callback_query: {
          id: 'cb-1',
          from: { id: 999 },
          message: { chat: { id: -100 }, message_id: 555, date: 1000 },
          data: 'something:42:not-a-clarify',
        },
      } as never,
      deps,
    );
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.sendReply).not.toHaveBeenCalled();
  });

  it('group-chat callback (chat.type=supergroup): dispatched with synthesized=true so dispatcher will skip context-gated filters', async () => {
    // Phase 1 LATENT BUG REGRESSION: in groups, the synthesized
    // "Yes"/"No" text would be rejected by TelegramGroupMentionFilter.
    // With `synthesized=true`, the dispatcher skips only those default
    // filters that opt out via `runOnSynthesized = false` (security
    // gates like TelegramAllowlistFilter still run — Phase 2
    // hardening). TelegramGroupMentionFilter declares
    // `runOnSynthesized = false` so this synthesized continuation is
    // not re-gated; the dispatcher-side contract test lives in
    // im-runtime's `dispatcher.test.ts`, the filter-side opt-out is
    // pinned in `tests/filters/group-mention.test.ts`.
    const deps = baseDeps();
    await handleCallbackQuery(
      {
        callback_query: {
          id: 'cb-1',
          from: { id: 999 },
          message: { chat: { id: -100, type: 'supergroup' }, message_id: 555, date: 1000 },
          data: 'clarify:42:0',
        },
      } as never,
      deps,
    );
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect((deps.dispatch.mock.calls[0][0] as InboundMessage).synthesized).toBe(true);
  });

  it('idempotent on double-tap: same clarify_data twice → 2 dispatch calls with same platformMsgId (dispatcher dedupe drops the second)', async () => {
    const deps = baseDeps();
    await handleCallbackQuery(
      {
        callback_query: {
          id: 'cb-1',
          from: { id: 999 },
          message: { chat: { id: -100 }, message_id: 555, date: 1000 },
          data: 'clarify:42:0',
        },
      } as never,
      deps,
    );
    await handleCallbackQuery(
      {
        callback_query: {
          id: 'cb-2',
          from: { id: 999 },
          message: { chat: { id: -100 }, message_id: 555, date: 1000 },
          data: 'clarify:42:0',
        },
      } as never,
      deps,
    );
    expect(deps.dispatch).toHaveBeenCalledTimes(2);
    expect((deps.dispatch.mock.calls[0][0] as InboundMessage).platformMsgId).toBe(
      'clarify-replay:42:0',
    );
    expect((deps.dispatch.mock.calls[1][0] as InboundMessage).platformMsgId).toBe(
      'clarify-replay:42:0',
    );
  });

  it('drops silently when callback_query has no chat (inline mode)', async () => {
    const deps = baseDeps();
    await handleCallbackQuery(
      {
        callback_query: {
          id: 'cb-1',
          from: { id: 999 },
          inline_message_id: 'inline-1',
          data: 'clarify:42:0',
        },
      } as never,
      deps,
    );
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.sendReply).not.toHaveBeenCalled();
  });
});

describe('handleCallbackQuery (P4 keyed)', () => {
  it('dispatches with forcedIntent + originalUser text + sessionKey override', async () => {
    const deps = baseDeps();
    await handleCallbackQuery(
      {
        callback_query: {
          id: 'cb-keyed-1',
          from: { id: 999 },
          message: { chat: { id: -100 }, message_id: 555, date: 1000 },
          data: 'clarify:42:create_note',
        },
      } as never,
      deps,
    );
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    const dispatched = deps.dispatch.mock.calls[0][0] as InboundMessage;
    expect(dispatched.contentType).toBe('text');
    expect(dispatched.synthesized).toBe(true);
    expect(dispatched.text).toBe('track Apple stock');
    expect(dispatched.forcedIntent).toBe('create_note');
    expect(dispatched.payload).toBeUndefined();
    expect(dispatched.sessionKeyOverride).toBe('telegram:bot:-100');
    expect(dispatched.sessionRefOverride).toEqual({
      channelId: 'telegram',
      accountId: 'bot',
      chatId: '-100',
      userId: '999',
    });
    expect(dispatched.platformMsgId).toBe('clarify-keyed:42:create_note');
  });

  it('carries the payload through to the dispatch', async () => {
    const deps = baseDeps();
    await handleCallbackQuery(
      {
        callback_query: {
          id: 'cb-keyed-2',
          from: { id: 999 },
          message: { chat: { id: -100 }, message_id: 555, date: 1000 },
          data: 'clarify:42:submit_url:source-hint-7',
        },
      } as never,
      deps,
    );
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    const dispatched = deps.dispatch.mock.calls[0][0] as InboundMessage;
    expect(dispatched.forcedIntent).toBe('submit_url');
    expect(dispatched.payload).toBe('source-hint-7');
  });

  it('resolve_tracking_entity: replies static web-only hint, does not dispatch', async () => {
    const deps = baseDeps();
    await handleCallbackQuery(
      {
        callback_query: {
          id: 'cb-track',
          from: { id: 999 },
          message: { chat: { id: -100 }, message_id: 555, date: 1000 },
          data: 'clarify:42:resolve_tracking_entity:{"ruleId":7}',
        },
      } as never,
      deps,
    );
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.sendReply).toHaveBeenCalledTimes(1);
    const replyArg = deps.sendReply.mock.calls[0][1] as { text: string };
    expect(replyArg.text).toMatch(/web/i);
  });

  it('stale clarify row: replies expired + clears keyboard, no dispatch', async () => {
    const deps = baseDeps();
    deps.conversationRepo.getMessageById = vi.fn().mockReturnValue(null);
    await handleCallbackQuery(
      {
        callback_query: {
          id: 'cb-keyed-stale',
          from: { id: 999 },
          message: { chat: { id: -100 }, message_id: 555, date: 1000 },
          data: 'clarify:42:create_note',
        },
      } as never,
      deps,
    );
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.sendReply).toHaveBeenCalledTimes(1);
    expect(deps.editMessageReplyMarkup).toHaveBeenCalledWith(-100, 555);
  });

  it('cross-chat replay: replies expired + clears keyboard, no dispatch', async () => {
    const deps = baseDeps();
    deps.conversationRepo.getMessageById = vi.fn().mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'telegram:bot:-200',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'which?',
      metadata: { resultType: 'clarify', options: ['Yes', 'No'] },
      createdAt: new Date(),
    });
    await handleCallbackQuery(
      {
        callback_query: {
          id: 'cb-keyed-replay',
          from: { id: 999 },
          message: { chat: { id: -100 }, message_id: 555, date: 1000 },
          data: 'clarify:42:create_note',
        },
      } as never,
      deps,
    );
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.sendReply).toHaveBeenCalledTimes(1);
    expect(deps.editMessageReplyMarkup).toHaveBeenCalledWith(-100, 555);
  });

  it('non-clarify row: replies expired + clears keyboard, no dispatch', async () => {
    const deps = baseDeps();
    deps.conversationRepo.getMessageById = vi.fn().mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'telegram:bot:-100',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'done',
      metadata: { resultType: 'action' },
      createdAt: new Date(),
    });
    await handleCallbackQuery(
      {
        callback_query: {
          id: 'cb-keyed-not-clarify',
          from: { id: 999 },
          message: { chat: { id: -100 }, message_id: 555, date: 1000 },
          data: 'clarify:42:create_note',
        },
      } as never,
      deps,
    );
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.sendReply).toHaveBeenCalledTimes(1);
    expect(deps.editMessageReplyMarkup).toHaveBeenCalledWith(-100, 555);
  });

  it('clarify row found but no preceding user turn: replies expired', async () => {
    const deps = baseDeps();
    deps.conversationRepo.loadConversationById = vi.fn().mockReturnValue({
      id: 1,
      sessionKey: 'telegram:bot:-100',
      channelId: 'telegram',
      archivedAt: null,
      // Only the assistant clarify exists (corrupt history / first turn was assistant somehow).
      messages: [{ id: 42, role: 'assistant', content: 'which?', metadata: {}, createdAt: 1 }],
    });
    await handleCallbackQuery(
      {
        callback_query: {
          id: 'cb-keyed-no-user',
          from: { id: 999 },
          message: { chat: { id: -100 }, message_id: 555, date: 1000 },
          data: 'clarify:42:create_note',
        },
      } as never,
      deps,
    );
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.sendReply).toHaveBeenCalledTimes(1);
  });
});
