// monorepo/packages/im-runtime/tests/multi-channel.test.ts
/**
 * INVARIANT: Two channels with the same chatId/userId must NEVER share a sessionKey
 * because the channelId is part of the prefix. This test pins the invariant by directly
 * constructing two SessionRouter calls and proving they diverge.
 */
import { describe, expect, it } from 'vitest';
import { SessionRouter } from '../src/inbound/router.js';
import type { InboundMessage } from '../src/types.js';

const m = (channelId: string): InboundMessage => ({
  channelId,
  accountId: 'bot',
  chatId: 'shared-chat',
  userId: 'shared-user',
  platformMsgId: 'x',
  text: 't',
  contentType: 'text',
  raw: null,
  receivedAt: new Date(),
});

describe('Multi-channel isolation', () => {
  it('two channels with identical chat/user ids never collide on sessionKey', () => {
    const router = new SessionRouter({ routingMode: 'per_chat' });
    expect(router.buildSessionKey(m('telegram'))).not.toBe(router.buildSessionKey(m('slack')));
  });
});
