import type { InboundMessage } from '@goldpan/im-runtime';
import { describe, expect, it } from 'vitest';
import { TelegramAllowlistFilter } from '../../src/filters/allowlist.js';

const m = (chatId: string): InboundMessage => ({
  channelId: 'telegram',
  accountId: 'bot',
  chatId,
  userId: 'u',
  platformMsgId: 'm',
  text: 'hi',
  contentType: 'text',
  raw: null,
  receivedAt: new Date(),
});

describe('TelegramAllowlistFilter', () => {
  it('throws at construction if allowlist is empty', () => {
    expect(() => new TelegramAllowlistFilter({ allowedChatIds: [] })).toThrow(
      /allowlist is required/i,
    );
  });

  it('throws at construction if allowedChatIds contains only blank entries', () => {
    expect(() => new TelegramAllowlistFilter({ allowedChatIds: ['', '  '] })).toThrow(
      /allowlist is required/i,
    );
  });

  it('passes a message from an allowed chat', () => {
    const f = new TelegramAllowlistFilter({ allowedChatIds: ['111', '222'] });
    expect(f.shouldHandle(m('222'))).toEqual({ type: 'pass' });
  });

  it('silently rejects a message from a disallowed chat (no reply leaks bot existence)', () => {
    const f = new TelegramAllowlistFilter({ allowedChatIds: ['111'] });
    // `reject` (not `short_circuit`) — disallowed chats receive no reply, both
    // to avoid signalling the bot's presence to attackers and to prevent the
    // bot's outbound API quota from being burned by repeated rejection
    // messages on synthesised platform_msg_ids.
    expect(f.shouldHandle(m('999'))).toEqual({ type: 'reject' });
  });

  it('matches as exact strings (no numeric coercion surprises)', () => {
    const f = new TelegramAllowlistFilter({ allowedChatIds: ['-100123'] });
    expect(f.shouldHandle(m('-100123'))).toEqual({ type: 'pass' });
    expect(f.shouldHandle(m('100123'))).toEqual({ type: 'reject' });
  });
});
