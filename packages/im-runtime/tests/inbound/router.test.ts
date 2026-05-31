import { describe, expect, it } from 'vitest';
import { parseSessionKey, SessionRouter } from '../../src/inbound/router.js';
import type { InboundMessage } from '../../src/types.js';

const baseMsg = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  channelId: 'telegram',
  accountId: 'bot1',
  chatId: 'chat-A',
  userId: 'user-X',
  platformMsgId: 'msg-1',
  text: 'hi',
  contentType: 'text',
  raw: null,
  receivedAt: new Date(),
  ...overrides,
});

describe('SessionRouter', () => {
  it('per_chat mode → key = channel:account:chat', () => {
    const r = new SessionRouter({ routingMode: 'per_chat' });
    const k = r.buildSessionKey(baseMsg());
    expect(k).toBe('telegram:bot1:chat-A');
  });

  it('per_user mode → key = channel:account:chat:user', () => {
    const r = new SessionRouter({ routingMode: 'per_user' });
    const k = r.buildSessionKey(baseMsg());
    expect(k).toBe('telegram:bot1:chat-A:user-X');
  });

  it('per_chat is stable across users in same chat', () => {
    const r = new SessionRouter({ routingMode: 'per_chat' });
    const a = r.buildSessionKey(baseMsg({ userId: 'alice' }));
    const b = r.buildSessionKey(baseMsg({ userId: 'bob' }));
    expect(a).toBe(b);
  });

  it('per_user differentiates users in same chat', () => {
    const r = new SessionRouter({ routingMode: 'per_user' });
    const a = r.buildSessionKey(baseMsg({ userId: 'alice' }));
    const b = r.buildSessionKey(baseMsg({ userId: 'bob' }));
    expect(a).not.toBe(b);
  });

  it('different channels never collide even with identical chat/user IDs', () => {
    const r = new SessionRouter({ routingMode: 'per_chat' });
    const a = r.buildSessionKey(baseMsg({ channelId: 'telegram' }));
    const b = r.buildSessionKey(baseMsg({ channelId: 'slack' }));
    expect(a).not.toBe(b);
  });

  it('throws on unknown routingMode', () => {
    const r = new SessionRouter({ routingMode: 'bogus' as never });
    expect(() => r.buildSessionKey(baseMsg())).toThrow(/unknown routingMode/);
  });
});

describe('parseSessionKey', () => {
  it('inverts buildSessionKey(per_chat) and recovers channel/account/chat', () => {
    const r = new SessionRouter({ routingMode: 'per_chat' });
    const key = r.buildSessionKey(baseMsg());
    expect(parseSessionKey(key)).toEqual({
      scope: 'per_chat',
      channelId: 'telegram',
      accountId: 'bot1',
      chatId: 'chat-A',
    });
  });

  it('inverts buildSessionKey(per_user) and recovers the full actor tuple', () => {
    const r = new SessionRouter({ routingMode: 'per_user' });
    const key = r.buildSessionKey(baseMsg({ userId: 'alice' }));
    expect(parseSessionKey(key)).toEqual({
      scope: 'per_user',
      channelId: 'telegram',
      accountId: 'bot1',
      chatId: 'chat-A',
      userId: 'alice',
    });
  });

  it('returns null for unrecognized segment counts', () => {
    expect(parseSessionKey('a:b')).toBeNull();
    expect(parseSessionKey('a:b:c:d:e')).toBeNull();
  });
});

describe('SessionRouter — thread support', () => {
  const feishuMsg = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
    channelId: 'feishu',
    accountId: 'cli_x',
    chatId: 'oc_1',
    userId: 'ou_user',
    platformMsgId: 'om_1',
    contentType: 'text',
    raw: null,
    receivedAt: new Date(),
    ...overrides,
  });

  it('per_chat: threaded message gets a thread-suffixed sessionKey', () => {
    const router = new SessionRouter({ routingMode: 'per_chat' });
    expect(router.buildSessionKey(feishuMsg({ threadId: 'omt_a' }))).toBe(
      'feishu:cli_x:oc_1:t=omt_a',
    );
    expect(router.buildSessionKey(feishuMsg())).toBe('feishu:cli_x:oc_1');
  });

  it('per_user: thread suffix appears AFTER user', () => {
    const router = new SessionRouter({ routingMode: 'per_user' });
    expect(router.buildSessionKey(feishuMsg({ threadId: 'omt_a' }))).toBe(
      'feishu:cli_x:oc_1:ou_user:t=omt_a',
    );
  });

  it('SessionRef carries threadId when set', () => {
    const router = new SessionRouter({ routingMode: 'per_chat' });
    const ref = router.buildSessionRef(feishuMsg({ threadId: 'omt_a' }));
    expect(ref.threadId).toBe('omt_a');
  });

  it('SessionRef omits threadId when unset', () => {
    const router = new SessionRouter({ routingMode: 'per_chat' });
    const ref = router.buildSessionRef(feishuMsg());
    expect(ref.threadId).toBeUndefined();
  });
});

describe('parseSessionKey — thread support', () => {
  it('parses per_chat with thread suffix', () => {
    expect(parseSessionKey('feishu:cli_x:oc_1:t=omt_a')).toEqual({
      scope: 'per_chat',
      channelId: 'feishu',
      accountId: 'cli_x',
      chatId: 'oc_1',
      threadId: 'omt_a',
    });
  });

  it('parses per_user with thread suffix', () => {
    expect(parseSessionKey('feishu:cli_x:oc_1:ou_user:t=omt_a')).toEqual({
      scope: 'per_user',
      channelId: 'feishu',
      accountId: 'cli_x',
      chatId: 'oc_1',
      userId: 'ou_user',
      threadId: 'omt_a',
    });
  });

  it('preserves Phase 1 backward shape when no thread suffix is present', () => {
    expect(parseSessionKey('telegram:bot:c1')).toEqual({
      scope: 'per_chat',
      channelId: 'telegram',
      accountId: 'bot',
      chatId: 'c1',
    });
  });
});
