import type { InboundMessage } from '@goldpan/im-runtime';
import { describe, expect, it } from 'vitest';
import { TelegramUnsupportedFilter } from '../../src/filters/unsupported.js';

const msg = (contentType: InboundMessage['contentType']): InboundMessage => ({
  channelId: 'telegram',
  accountId: 'bot',
  chatId: 'c',
  userId: 'u',
  platformMsgId: 'm',
  text: undefined,
  contentType,
  raw: null,
  receivedAt: new Date(),
});

describe('TelegramUnsupportedFilter', () => {
  const f = new TelegramUnsupportedFilter({
    message: 'I currently only handle text messages.',
  });

  it('passes text messages', () => {
    expect(f.shouldHandle({ ...msg('text'), text: 'hi' })).toEqual({ type: 'pass' });
  });

  it.each([
    'image',
    'voice',
    'video',
    'file',
    'other',
  ] as const)('short-circuits %s with the injected message (channel-local i18n)', (contentType) => {
    const decision = f.shouldHandle(msg(contentType));
    expect(decision.type).toBe('short_circuit');
    if (decision.type !== 'short_circuit') throw new Error('unreachable');
    expect(decision.reply.text).toBe('I currently only handle text messages.');
    expect(decision.reply.format).toBe('plain');
  });

  it('honors a different injected message (e.g. a Chinese localization)', () => {
    const zh = new TelegramUnsupportedFilter({ message: '目前我只能处理文字消息。' });
    const decision = zh.shouldHandle(msg('image'));
    if (decision.type !== 'short_circuit') throw new Error('unreachable');
    expect(decision.reply.text).toBe('目前我只能处理文字消息。');
  });
});
