import { describe, expect, it, vi } from 'vitest';
import { buildClarifyReplay, parseClarifyCallback } from '../../src/callbacks/clarify-callback.js';

describe('parseClarifyCallback (legacy shape)', () => {
  it('parses a well-formed legacy callback_data', () => {
    expect(parseClarifyCallback('clarify:42:1')).toEqual({
      shape: 'legacy',
      conversationMessageId: 42,
      optionIndex: 1,
    });
  });
  it('returns null for unknown prefix', () => {
    expect(parseClarifyCallback('other:1:2')).toBeNull();
  });
  it('returns null when parts < 3', () => {
    expect(parseClarifyCallback('clarify:foo')).toBeNull();
  });
  it('returns null when conversationMessageId is not numeric', () => {
    expect(parseClarifyCallback('clarify:foo:1')).toBeNull();
  });
});

describe('parseClarifyCallback (P4 keyed shape)', () => {
  it('parses keyed callback_data without payload', () => {
    expect(parseClarifyCallback('clarify:42:create_note')).toEqual({
      shape: 'keyed',
      conversationMessageId: 42,
      intentKey: 'create_note',
    });
  });

  it('parses keyed callback_data with a simple payload', () => {
    expect(parseClarifyCallback('clarify:42:submit_url:hint')).toEqual({
      shape: 'keyed',
      conversationMessageId: 42,
      intentKey: 'submit_url',
      payload: 'hint',
    });
  });

  // Tracking-related payloads serialize JSON which itself contains `:`.
  // The parser must preserve the full tail so the plugin can re-parse the JSON.
  it('preserves colons in the payload tail', () => {
    expect(
      parseClarifyCallback('clarify:7:resolve_tracking_entity:{"ruleId":1,"entityId":42}'),
    ).toEqual({
      shape: 'keyed',
      conversationMessageId: 7,
      intentKey: 'resolve_tracking_entity',
      payload: '{"ruleId":1,"entityId":42}',
    });
  });

  // 3 parts with non-numeric parts[2] (e.g. "nine") MUST be treated as keyed,
  // not as malformed legacy. Pre-P4 tests asserted null here; that contract
  // changed deliberately when the keyed shape landed.
  it('treats 3-part callback with non-numeric parts[2] as keyed', () => {
    expect(parseClarifyCallback('clarify:42:nine')).toEqual({
      shape: 'keyed',
      conversationMessageId: 42,
      intentKey: 'nine',
    });
  });
});

describe('buildClarifyReplay', () => {
  const repo = {
    getMessageById: vi.fn(),
  };

  const actor = (
    overrides: Partial<{
      channelId: string;
      accountId: string;
      chatId: string;
      userId: string;
    }> = {},
  ) => ({
    channelId: 'telegram',
    accountId: 'bot',
    chatId: 'chat',
    userId: 'actor-1',
    ...overrides,
  });

  it('returns replay text with the chosen option string', () => {
    repo.getMessageById.mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'telegram:bot:chat',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'which?',
      metadata: { resultType: 'clarify', options: ['Apple', 'Banana'] },
      createdAt: new Date(),
    });
    const out = buildClarifyReplay(
      { shape: 'legacy', conversationMessageId: 42, optionIndex: 1 },
      repo as never,
      actor(),
    );
    expect(out).toEqual({
      status: 'ok',
      text: 'Banana',
      sessionKey: 'telegram:bot:chat',
      sessionRef: {
        channelId: 'telegram',
        accountId: 'bot',
        chatId: 'chat',
        userId: 'actor-1',
      },
    });
  });

  it('returns stale when message not found', () => {
    repo.getMessageById.mockReturnValue(null);
    const out = buildClarifyReplay(
      { shape: 'legacy', conversationMessageId: 99, optionIndex: 0 },
      repo as never,
      actor(),
    );
    expect(out.status).toBe('stale');
  });

  it('returns stale when index out of range', () => {
    repo.getMessageById.mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'telegram:bot:chat:actor-1',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'which?',
      metadata: { resultType: 'clarify', options: ['Apple'] },
      createdAt: new Date(),
    });
    const out = buildClarifyReplay(
      { shape: 'legacy', conversationMessageId: 42, optionIndex: 9 },
      repo as never,
      actor(),
    );
    expect(out.status).toBe('stale');
  });

  it('returns stale when metadata.resultType is not "clarify"', () => {
    repo.getMessageById.mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'telegram:bot:chat:actor-1',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'normal answer',
      metadata: { resultType: 'content', options: ['Apple', 'Banana'] },
      createdAt: new Date(),
    });
    const out = buildClarifyReplay(
      { shape: 'legacy', conversationMessageId: 42, optionIndex: 0 },
      repo as never,
      actor(),
    );
    expect(out.status).toBe('stale');
  });

  it('returns stale when metadata is missing entirely', () => {
    repo.getMessageById.mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'telegram:bot:chat:actor-1',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'which?',
      metadata: undefined,
      createdAt: new Date(),
    });
    const out = buildClarifyReplay(
      { shape: 'legacy', conversationMessageId: 42, optionIndex: 0 },
      repo as never,
      actor(),
    );
    expect(out.status).toBe('stale');
  });

  it('returns stale when a different user taps a per_user clarify button', () => {
    repo.getMessageById.mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'telegram:bot:chat:owner-1',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'which?',
      metadata: { resultType: 'clarify', options: ['Apple', 'Banana'] },
      createdAt: new Date(),
    });
    const out = buildClarifyReplay(
      { shape: 'legacy', conversationMessageId: 42, optionIndex: 1 },
      repo as never,
      actor({ userId: 'other-user' }),
    );
    expect(out.status).toBe('stale');
  });

  it('allows per_chat clarify replay from any user in the same chat', () => {
    repo.getMessageById.mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'telegram:bot:chatA',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'which?',
      metadata: { resultType: 'clarify', options: ['Apple', 'Banana'] },
      createdAt: new Date(),
    });
    const out = buildClarifyReplay(
      { shape: 'legacy', conversationMessageId: 42, optionIndex: 1 },
      repo as never,
      actor({ chatId: 'chatA', userId: 'other-user' }),
    );
    expect(out).toEqual({
      status: 'ok',
      text: 'Banana',
      sessionKey: 'telegram:bot:chatA',
      sessionRef: {
        channelId: 'telegram',
        accountId: 'bot',
        chatId: 'chatA',
        userId: 'other-user',
      },
    });
  });

  // Security regression: clarify callbacks carry no HMAC and their
  // conversationMessageId is an enumerable auto-increment integer. Without
  // checking that the replayer is actually in the originating chat, an actor in
  // any other allowlisted chat could forge `clarify:<M>:<i>` to (a) inject a
  // chosen user turn into the victim chat's conversation history and (b)
  // receive an LLM answer grounded in the victim chat's private context.
  it('returns stale when per_chat replay comes from a different chat', () => {
    repo.getMessageById.mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'telegram:bot:chatA',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'which?',
      metadata: { resultType: 'clarify', options: ['Apple', 'Banana'] },
      createdAt: new Date(),
    });
    const out = buildClarifyReplay(
      { shape: 'legacy', conversationMessageId: 42, optionIndex: 1 },
      repo as never,
      actor({ chatId: 'chatB' }),
    );
    expect(out.status).toBe('stale');
  });

  it('returns stale when per_user replay comes from a different chat by the same user', () => {
    repo.getMessageById.mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'telegram:bot:chatA:userX',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'which?',
      metadata: { resultType: 'clarify', options: ['Apple', 'Banana'] },
      createdAt: new Date(),
    });
    const out = buildClarifyReplay(
      { shape: 'legacy', conversationMessageId: 42, optionIndex: 1 },
      repo as never,
      actor({ chatId: 'chatB', userId: 'userX' }),
    );
    expect(out.status).toBe('stale');
  });

  it('returns stale when replay comes from a different bot account', () => {
    repo.getMessageById.mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'telegram:botA:chat',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'which?',
      metadata: { resultType: 'clarify', options: ['Apple', 'Banana'] },
      createdAt: new Date(),
    });
    const out = buildClarifyReplay(
      { shape: 'legacy', conversationMessageId: 42, optionIndex: 1 },
      repo as never,
      actor({ accountId: 'botB' }),
    );
    expect(out.status).toBe('stale');
  });

  it('returns stale when replay comes from a different channel', () => {
    repo.getMessageById.mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'telegram:bot:chat',
      conversationArchivedAt: null,
      role: 'assistant',
      content: 'which?',
      metadata: { resultType: 'clarify', options: ['Apple', 'Banana'] },
      createdAt: new Date(),
    });
    const out = buildClarifyReplay(
      { shape: 'legacy', conversationMessageId: 42, optionIndex: 1 },
      repo as never,
      actor({ channelId: 'slack' }),
    );
    expect(out.status).toBe('stale');
  });

  it('returns stale when the clarify message belongs to an archived conversation', () => {
    repo.getMessageById.mockReturnValue({
      id: 42,
      conversationId: 1,
      sessionKey: 'telegram:bot:chat',
      conversationArchivedAt: new Date(),
      role: 'assistant',
      content: 'which?',
      metadata: { resultType: 'clarify', options: ['Apple', 'Banana'] },
      createdAt: new Date(),
    });
    const out = buildClarifyReplay(
      { shape: 'legacy', conversationMessageId: 42, optionIndex: 0 },
      repo as never,
      actor(),
    );
    expect(out.status).toBe('stale');
  });
});
