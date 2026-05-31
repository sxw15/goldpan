import type { InboundMessage } from '@goldpan/im-runtime';
import { describe, expect, it, vi } from 'vitest';
import { handleCardActionEvent } from '../../src/callbacks/card-action.js';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

const baseDeps = (overrides: Partial<Parameters<typeof handleCardActionEvent>[1]> = {}) => ({
  dispatch: vi.fn(async () => {}),
  conversationRepo: {
    getMessageById: vi.fn().mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'feishu:cli_x:oc_1',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'pick one',
      metadata: { resultType: 'clarify', options: ['Yes', 'No'] },
      createdAt: new Date(),
    }),
  } as never,
  sendReply: vi.fn(async () => {}),
  language: 'en' as const,
  logger: stubLogger,
  accountId: 'cli_x',
  ...overrides,
});

const event = (overrides: Record<string, unknown> = {}) => ({
  event: {
    operator: { open_id: 'ou_user' },
    chat_id: 'oc_1',
    action: { value: { action: 'clarify', conversationMessageId: 42, optionIndex: 1 } },
    ...overrides,
  },
});

describe('handleCardActionEvent', () => {
  it('valid clarify: dispatches synthesized text msg with deterministic replay id', async () => {
    const deps = baseDeps();
    await handleCardActionEvent(event(), deps);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    const dispatched = deps.dispatch.mock.calls[0][0] as InboundMessage;
    expect(dispatched.contentType).toBe('text');
    expect(dispatched.synthesized).toBe(true);
    expect(dispatched.text).toBe('No');
    expect(dispatched.platformMsgId).toBe('card-action-clarify:42:1');
    expect(dispatched.sessionKeyOverride).toBe('feishu:cli_x:oc_1');
    expect(dispatched.sessionRefOverride).toEqual({
      channelId: 'feishu',
      accountId: 'cli_x',
      chatId: 'oc_1',
      userId: 'ou_user',
    });
    expect(dispatched.chatId).toBe('oc_1');
    expect(dispatched.userId).toBe('ou_user');
    expect(deps.sendReply).not.toHaveBeenCalled();
  });

  it('threaded clarify: restores threadId into sessionRefOverride from the stored sessionKey', async () => {
    const deps = baseDeps();
    deps.conversationRepo.getMessageById = vi.fn().mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'feishu:cli_x:oc_1:t=omt_thread',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'pick one',
      metadata: { resultType: 'clarify', options: ['Yes', 'No'] },
      createdAt: new Date(),
    });
    await handleCardActionEvent(event(), deps);
    const dispatched = deps.dispatch.mock.calls[0][0] as InboundMessage;
    expect(dispatched.sessionKeyOverride).toBe('feishu:cli_x:oc_1:t=omt_thread');
    expect(dispatched.sessionRefOverride).toEqual({
      channelId: 'feishu',
      accountId: 'cli_x',
      chatId: 'oc_1',
      userId: 'ou_user',
      threadId: 'omt_thread',
    });
  });

  it('drops invalid action.value silently', async () => {
    const deps = baseDeps();
    await handleCardActionEvent(
      { event: { operator: { open_id: 'ou' }, chat_id: 'oc_1', action: {} } },
      deps,
    );
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.sendReply).not.toHaveBeenCalled();
  });

  it('archived conversation: sends red expired card; does NOT dispatch', async () => {
    const deps = baseDeps();
    deps.conversationRepo.getMessageById = vi.fn().mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'feishu:cli_x:oc_1',
      conversationArchivedAt: new Date(),
      role: 'assistant',
      content: 'pick',
      metadata: { resultType: 'clarify', options: ['Yes', 'No'] },
      createdAt: new Date(),
    });
    await handleCardActionEvent(event(), deps);
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.sendReply).toHaveBeenCalledTimes(1);
  });

  it('option index out of range: sends expired card; does NOT dispatch', async () => {
    const deps = baseDeps();
    deps.conversationRepo.getMessageById = vi.fn().mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'feishu:cli_x:oc_1',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'pick',
      metadata: { resultType: 'clarify', options: ['Yes'] },
      createdAt: new Date(),
    });
    await handleCardActionEvent(
      {
        event: {
          operator: { open_id: 'ou_user' },
          chat_id: 'oc_1',
          action: { value: { action: 'clarify', conversationMessageId: 42, optionIndex: 99 } },
        },
      },
      deps,
    );
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.sendReply).toHaveBeenCalledTimes(1);
  });

  it('non-clarify metadata.resultType: sends expired card', async () => {
    const deps = baseDeps();
    deps.conversationRepo.getMessageById = vi.fn().mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'feishu:cli_x:oc_1',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'something else',
      metadata: { resultType: 'content' },
      createdAt: new Date(),
    });
    await handleCardActionEvent(event(), deps);
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.sendReply).toHaveBeenCalledTimes(1);
  });

  it('missing row: sends expired card', async () => {
    const deps = baseDeps();
    deps.conversationRepo.getMessageById = vi.fn().mockReturnValue(undefined);
    await handleCardActionEvent(event(), deps);
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.sendReply).toHaveBeenCalledTimes(1);
  });

  it('cross-chat replay: refuses when actor chat_id mismatches row sessionKey', async () => {
    // Security regression guard: Lark's action.value `conversationMessageId` is
    // an enumerable auto-increment int. If chatB's card event references
    // chatA's message id, the handler MUST reject rather than drive a reply
    // into chatA's session. Mirrors Telegram's isReplayAuthorized check.
    const deps = baseDeps();
    deps.conversationRepo.getMessageById = vi.fn().mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'feishu:cli_x:oc_original',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'pick',
      metadata: { resultType: 'clarify', options: ['Yes', 'No'] },
      createdAt: new Date(),
    });
    await handleCardActionEvent(
      {
        event: {
          operator: { open_id: 'ou_user' },
          chat_id: 'oc_attacker',
          action: { value: { action: 'clarify', conversationMessageId: 42, optionIndex: 0 } },
        },
      },
      deps,
    );
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.sendReply).toHaveBeenCalledTimes(1);
  });
});
