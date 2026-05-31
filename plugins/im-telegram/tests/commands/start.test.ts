import { describe, expect, it, vi } from 'vitest';
import { startCommandOverride } from '../../src/commands/start.js';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

describe('startCommandOverride', () => {
  it('returns the English welcome text when language is "en"', async () => {
    const reply = await startCommandOverride.handle!(
      { name: 'start', args: '', raw: '/start' },
      {
        channelId: 'telegram',
        accountId: 'b',
        chatId: 'c',
        userId: 'u',
        platformMsgId: 'm',
        contentType: 'text',
        raw: null,
        receivedAt: new Date(),
      },
      {
        sessionRef: { channelId: 'telegram', accountId: 'b', chatId: 'c', userId: 'u' },
        sessionKey: 'telegram:b:c',
        conversation: null,
        conversationRepo: {} as never,
        logger: stubLogger,
        language: 'en',
      },
    );
    expect((reply as { text: string }).text).toMatch(/Hi! I'm your knowledge assistant/);
  });

  it('returns the Chinese welcome text when language is "zh"', async () => {
    const reply = await startCommandOverride.handle!(
      { name: 'start', args: '', raw: '/start' },
      {
        channelId: 'telegram',
        accountId: 'b',
        chatId: 'c',
        userId: 'u',
        platformMsgId: 'm',
        contentType: 'text',
        raw: null,
        receivedAt: new Date(),
      },
      {
        sessionRef: { channelId: 'telegram', accountId: 'b', chatId: 'c', userId: 'u' },
        sessionKey: 'telegram:b:c',
        conversation: null,
        conversationRepo: {} as never,
        logger: stubLogger,
        language: 'zh',
      },
    );
    expect((reply as { text: string }).text).toMatch(/你好！我是你的知识助手/);
  });
});
