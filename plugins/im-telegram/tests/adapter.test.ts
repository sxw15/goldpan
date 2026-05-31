import { describe, expect, it, vi } from 'vitest';
import { createTelegramAdapter } from '../src/adapter.js';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

const baseRenderCtx = () => ({
  language: 'en' as const,
  sessionRef: { channelId: 'telegram', accountId: 'a', chatId: 'c', userId: 'u' },
  channelConfig: {} as Record<string, unknown>,
  logger: stubLogger,
});

describe('createTelegramAdapter', () => {
  it('returns a ChannelAdapter with the expected channelId and capabilities', () => {
    const adapter = createTelegramAdapter({
      conversationRepo: { getMessageById: vi.fn() } as never,
    });
    expect(adapter.channelId).toBe('telegram');
    expect(adapter.capabilities.inlineButtons).toBe(true);
    expect(adapter.capabilities.maxMessageLength).toBe(4096);
    expect(typeof adapter.start).toBe('function');
    expect(typeof adapter.shutdown).toBe('function');
  });

  it('renderError delegates to the i18n loader (lowercase InputErrorCode)', () => {
    const adapter = createTelegramAdapter({
      conversationRepo: { getMessageById: vi.fn() } as never,
    });
    const reply = adapter.renderError('text_too_long', { maxLen: 100 }, baseRenderCtx());
    expect((reply as { text: string }).text).toMatch(
      /Your message is too long \(max 100 characters\)\./,
    );
  });

  it('renderResult handles note and tracking_pending core result types', () => {
    const adapter = createTelegramAdapter({
      conversationRepo: { getMessageById: vi.fn() } as never,
    });
    const ctx = baseRenderCtx();

    const noteReply = adapter.renderResult(
      {
        type: 'note',
        detail: {
          id: 42,
          content: 'remember this',
          contentTranslated: null,
          language: 'en',
          subtype: 'note',
          pinned: false,
          archived: false,
          sourceMessageId: null,
          tags: [],
          linkedEntities: [],
          linkedSources: [],
          createdAt: 1,
          updatedAt: 1,
        },
      },
      ctx,
    );
    expect(noteReply).toEqual({ text: 'Saved as note #42', format: 'plain' });

    const pendingReply = adapter.renderResult(
      { type: 'tracking_pending', trackingRuleId: 7, reasonKey: 'waiting_pipeline' },
      ctx,
    );
    expect(pendingReply).toEqual({
      text: 'Waiting for the source analysis to finish before setting up tracking',
      format: 'plain',
    });
  });

  it('buildSystemReply returns a plain-text Telegram payload', () => {
    const adapter = createTelegramAdapter({
      conversationRepo: { getMessageById: vi.fn() } as never,
    });
    const reply = adapter.buildSystemReply('please add text after /ask');
    expect(reply).toEqual({ text: 'please add text after /ask', format: 'plain' });
  });
});
