import { describe, expect, it } from 'vitest';
import { parseSessionKey } from '../../src/im/session-key.js';

describe('parseSessionKey', () => {
  it('parses per_user 4-segment key', () => {
    expect(parseSessionKey('telegram:botA:chat42:user7')).toEqual({
      channelId: 'telegram',
      accountId: 'botA',
      chatId: 'chat42',
      userId: 'user7',
    });
  });

  it('returns null on per_chat 3-segment keys — userId cannot be derived without inventing a value (P1-6)', () => {
    // Historically this returned `{..., userId: chatId}`, which under group-
    // chat per_chat routing collapsed every user's subscription onto a
    // single row (UNIQUE collision on channelId/accountId/chatId/userId).
    // Callers MUST now supply `IntentExecutionContext.sessionRef` — which
    // the IM runtime's inbound dispatcher populates — rather than relying
    // on this parser for 3-segment keys.
    expect(parseSessionKey('telegram:botA:chat42')).toBeNull();
  });

  it('returns null on malformed keys (too few / too many / empty segment)', () => {
    expect(parseSessionKey('')).toBeNull();
    expect(parseSessionKey('telegram:botA')).toBeNull();
    expect(parseSessionKey('a:b:c:d:e')).toBeNull();
    expect(parseSessionKey('telegram:botA::user7')).toBeNull();
  });
});
