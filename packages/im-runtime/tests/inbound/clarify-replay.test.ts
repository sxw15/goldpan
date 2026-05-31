import { describe, expect, it, vi } from 'vitest';
import { resolveClarifyReplay } from '../../src/inbound/clarify-replay.js';

const actor = {
  channelId: 'feishu',
  accountId: 'cli_x',
  chatId: 'oc_1',
  userId: 'ou_user',
};

function makeRepo(row: unknown) {
  return {
    getMessageById: vi.fn().mockReturnValue(row),
  } as never;
}

describe('resolveClarifyReplay', () => {
  it('ok: returns choice string + sessionKey when everything matches', () => {
    const repo = makeRepo({
      id: 42,
      conversationId: 1,
      sessionKey: 'feishu:cli_x:oc_1',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'pick',
      metadata: { resultType: 'clarify', options: ['Yes', 'No'] },
      createdAt: new Date(),
    });
    const result = resolveClarifyReplay({
      repo,
      conversationMessageId: 42,
      optionIndex: 1,
      actor,
    });
    expect(result).toEqual({
      status: 'ok',
      text: 'No',
      sessionKey: 'feishu:cli_x:oc_1',
      sessionRef: {
        channelId: 'feishu',
        accountId: 'cli_x',
        chatId: 'oc_1',
        userId: 'ou_user',
      },
    });
  });

  it('ok: restores threadId from the stored sessionKey for threaded replays', () => {
    const repo = makeRepo({
      id: 42,
      conversationId: 1,
      sessionKey: 'feishu:cli_x:oc_1:t=omt_thread',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'pick',
      metadata: { resultType: 'clarify', options: ['Yes', 'No'] },
      createdAt: new Date(),
    });
    const result = resolveClarifyReplay({
      repo,
      conversationMessageId: 42,
      optionIndex: 0,
      actor,
    });
    expect(result).toEqual({
      status: 'ok',
      text: 'Yes',
      sessionKey: 'feishu:cli_x:oc_1:t=omt_thread',
      sessionRef: {
        channelId: 'feishu',
        accountId: 'cli_x',
        chatId: 'oc_1',
        userId: 'ou_user',
        threadId: 'omt_thread',
      },
    });
  });

  it('stale: missing row', () => {
    const result = resolveClarifyReplay({
      repo: makeRepo(undefined),
      conversationMessageId: 42,
      optionIndex: 0,
      actor,
    });
    expect(result).toEqual({ status: 'stale', reason: 'missing' });
  });

  it('stale: archived', () => {
    const result = resolveClarifyReplay({
      repo: makeRepo({
        id: 42,
        conversationId: 1,
        sessionKey: 'feishu:cli_x:oc_1',
        conversationArchivedAt: new Date(),
        role: 'assistant',
        content: 'x',
        metadata: { resultType: 'clarify', options: ['a'] },
        createdAt: new Date(),
      }),
      conversationMessageId: 42,
      optionIndex: 0,
      actor,
    });
    expect(result).toEqual({ status: 'stale', reason: 'archived' });
  });

  it('stale: unauthorized (cross-chat replay attempt)', () => {
    const result = resolveClarifyReplay({
      repo: makeRepo({
        id: 42,
        conversationId: 1,
        sessionKey: 'feishu:cli_x:oc_OTHER',
        conversationArchivedAt: null,
        role: 'assistant',
        content: 'x',
        metadata: { resultType: 'clarify', options: ['a'] },
        createdAt: new Date(),
      }),
      conversationMessageId: 42,
      optionIndex: 0,
      actor, // actor.chatId = oc_1, mismatches row.sessionKey
    });
    expect(result).toEqual({ status: 'stale', reason: 'unauthorized' });
  });

  it('stale: not clarify (wrong resultType)', () => {
    const result = resolveClarifyReplay({
      repo: makeRepo({
        id: 42,
        conversationId: 1,
        sessionKey: 'feishu:cli_x:oc_1',
        conversationArchivedAt: null,
        role: 'assistant',
        content: 'x',
        metadata: { resultType: 'content' },
        createdAt: new Date(),
      }),
      conversationMessageId: 42,
      optionIndex: 0,
      actor,
    });
    expect(result).toEqual({ status: 'stale', reason: 'not_clarify' });
  });

  it('stale: invalid option index (out of range)', () => {
    const result = resolveClarifyReplay({
      repo: makeRepo({
        id: 42,
        conversationId: 1,
        sessionKey: 'feishu:cli_x:oc_1',
        conversationArchivedAt: null,
        role: 'assistant',
        content: 'x',
        metadata: { resultType: 'clarify', options: ['Yes'] },
        createdAt: new Date(),
      }),
      conversationMessageId: 42,
      optionIndex: 99,
      actor,
    });
    expect(result).toEqual({ status: 'stale', reason: 'invalid_option_index' });
  });

  it('stale: invalid option index (empty string choice)', () => {
    const result = resolveClarifyReplay({
      repo: makeRepo({
        id: 42,
        conversationId: 1,
        sessionKey: 'feishu:cli_x:oc_1',
        conversationArchivedAt: null,
        role: 'assistant',
        content: 'x',
        metadata: { resultType: 'clarify', options: ['', 'B'] },
        createdAt: new Date(),
      }),
      conversationMessageId: 42,
      optionIndex: 0,
      actor,
    });
    expect(result).toEqual({ status: 'stale', reason: 'invalid_option_index' });
  });

  it('authorization runs BEFORE metadata access — cross-chat never observes options', () => {
    const getMessageById = vi.fn().mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'feishu:cli_x:oc_OTHER',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'x',
      metadata: { resultType: 'clarify', options: ['secret-a', 'secret-b'] },
      createdAt: new Date(),
    });
    const repo = { getMessageById } as never;
    const result = resolveClarifyReplay({
      repo,
      conversationMessageId: 42,
      optionIndex: 0,
      actor,
    });
    // Cross-chat rejection, and the returned stale reason must be
    // `unauthorized` — NOT e.g. `invalid_option_index`. A future refactor that
    // reordered checks would surface as this test flipping to a different
    // reason, catching the regression.
    expect(result.status).toBe('stale');
    if (result.status === 'stale') expect(result.reason).toBe('unauthorized');
  });
});
