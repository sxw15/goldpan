import type { RenderContext } from '@goldpan/im-runtime';
import { describe, expect, it } from 'vitest';
import { renderClarify } from '../../src/render/clarify.js';

const ctx = (): RenderContext =>
  ({
    language: 'en',
    sessionRef: { channelId: 'telegram', accountId: 'b', chatId: 'c', userId: 'u' },
    channelConfig: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
  }) as never;

describe('renderClarify (legacy options)', () => {
  it('emits inline keyboard with one button per option', () => {
    const out = renderClarify(
      { type: 'clarify', question: 'which?', options: ['Apple', 'Banana'] },
      ctx(),
      { conversationMessageId: 42 },
    );
    expect(out.text).toContain('which?');
    expect(out.inlineButtons).toEqual([
      [
        { label: 'Apple', callbackData: 'clarify:42:0' },
        { label: 'Banana', callbackData: 'clarify:42:1' },
      ],
    ]);
  });

  it('renders question without buttons when options omitted', () => {
    const out = renderClarify({ type: 'clarify', question: 'free-form?' }, ctx(), {
      conversationMessageId: 1,
    });
    expect(out.text).toContain('free-form?');
    expect(out.inlineButtons).toBeUndefined();
  });
});

describe('renderClarify (P4 structuredOptions)', () => {
  it('emits keyed callback_data per structured option, labels from core i18n', () => {
    const out = renderClarify(
      {
        type: 'clarify',
        question: 'What did you mean?',
        structuredOptions: [{ intentKey: 'create_note' }, { intentKey: 'submit_url' }],
      },
      ctx(),
      { conversationMessageId: 42 },
    );
    expect(out.inlineButtons).toEqual([
      [
        { label: 'Save as note', callbackData: 'clarify:42:create_note' },
        { label: 'Submit URL', callbackData: 'clarify:42:submit_url' },
      ],
    ]);
  });

  it('embeds payload into callback_data when present', () => {
    const out = renderClarify(
      {
        type: 'clarify',
        question: 'Which?',
        structuredOptions: [{ intentKey: 'submit_url', payload: 'hint' }],
      },
      ctx(),
      { conversationMessageId: 7 },
    );
    expect(out.inlineButtons?.[0]?.[0]?.callbackData).toBe('clarify:7:submit_url:hint');
  });

  it('skips resolve_tracking_entity chip (IM unsupported, P5)', () => {
    const out = renderClarify(
      {
        type: 'clarify',
        question: 'Which?',
        structuredOptions: [
          { intentKey: 'resolve_tracking_entity', payload: '{"ruleId":1,"entityId":42}' },
          { intentKey: 'create_note' },
        ],
      },
      ctx(),
      { conversationMessageId: 9 },
    );
    expect(out.inlineButtons).toEqual([
      [{ label: 'Save as note', callbackData: 'clarify:9:create_note' }],
    ]);
  });

  it('skips chips whose callback_data would exceed 64 bytes', () => {
    const longPayload = 'x'.repeat(80);
    const out = renderClarify(
      {
        type: 'clarify',
        question: 'Which?',
        structuredOptions: [
          { intentKey: 'submit_url', payload: longPayload },
          { intentKey: 'create_note' },
        ],
      },
      ctx(),
      { conversationMessageId: 1 },
    );
    // long-payload chip dropped; short chip retained.
    expect(out.inlineButtons).toEqual([
      [{ label: 'Save as note', callbackData: 'clarify:1:create_note' }],
    ]);
  });

  it('falls back to legacy options when every structured chip is skipped', () => {
    const out = renderClarify(
      {
        type: 'clarify',
        question: 'Which?',
        structuredOptions: [{ intentKey: 'resolve_tracking_entity', payload: '{"x":1}' }],
        options: ['Manual fallback'],
      },
      ctx(),
      { conversationMessageId: 3 },
    );
    expect(out.inlineButtons).toEqual([
      [{ label: 'Manual fallback', callbackData: 'clarify:3:0' }],
    ]);
  });
});
