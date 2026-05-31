import { describe, expect, it, vi } from 'vitest';
import { createFeishuAdapter } from '../src/adapter.js';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

const baseRenderCtx = () => ({
  language: 'en' as const,
  sessionRef: { channelId: 'feishu', accountId: 'cli_x', chatId: 'oc_1', userId: 'ou' },
  channelConfig: {} as Record<string, unknown>,
  logger: stubLogger,
});

describe('createFeishuAdapter (shell)', () => {
  it('returns a ChannelAdapter with channelId="feishu" and the right capabilities', () => {
    const adapter = createFeishuAdapter({
      conversationRepo: { getMessageById: vi.fn() } as never,
    });
    expect(adapter.channelId).toBe('feishu');
    expect(adapter.capabilities.inlineButtons).toBe(true);
    expect(typeof adapter.start).toBe('function');
    expect(typeof adapter.shutdown).toBe('function');
  });

  it('buildSystemReply returns a text payload', () => {
    const adapter = createFeishuAdapter({
      conversationRepo: { getMessageById: vi.fn() } as never,
    });
    const reply = adapter.buildSystemReply('hello');
    expect(reply).toEqual({ kind: 'text', text: 'hello' });
  });

  it('renderError returns a red-header card', () => {
    const adapter = createFeishuAdapter({
      conversationRepo: { getMessageById: vi.fn() } as never,
    });
    const reply = adapter.renderError('text_too_long', { maxLen: 100 }, baseRenderCtx());
    expect((reply as { kind: string }).kind).toBe('interactive');
    const card = (reply as { card: { header: { template: string } } }).card;
    expect(card.header.template).toBe('red');
  });

  it('renderResult dispatches by IntentPluginResult.type', () => {
    const adapter = createFeishuAdapter({
      conversationRepo: { getMessageById: vi.fn() } as never,
    });
    const reply = adapter.renderResult(
      { type: 'content', text: 'plain note', format: 'text' } as never,
      baseRenderCtx(),
    );
    expect((reply as { kind: string }).kind).toBe('interactive');
  });

  it('renderResult handles note and tracking_pending core result types', () => {
    const adapter = createFeishuAdapter({
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
    ) as { card: { elements: Array<{ text: { content: string } }> } };
    expect(noteReply.card.elements[0]?.text.content).toBe('Saved as note #42');

    const pendingReply = adapter.renderResult(
      { type: 'tracking_pending', trackingRuleId: 7, reasonKey: 'waiting_pipeline' },
      ctx,
    ) as { card: { elements: Array<{ text: { content: string } }> } };
    expect(pendingReply.card.elements[0]?.text.content).toBe(
      'Waiting for the source analysis to finish before setting up tracking',
    );
  });

  it('buildHelpReply and buildResetReply exist (placeholders until T10)', () => {
    const adapter = createFeishuAdapter({
      conversationRepo: { getMessageById: vi.fn() } as never,
    });
    expect(typeof adapter.buildHelpReply).toBe('function');
    expect(typeof adapter.buildResetReply).toBe('function');
  });
});
