import { describe, expect, it, vi } from 'vitest';
import { renderClarify } from '../../src/render/clarify.js';

const ctx = () => ({
  language: 'en' as const,
  sessionRef: { channelId: 'feishu', accountId: 'cli_x', chatId: 'oc_1', userId: 'ou' },
  channelConfig: {},
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  assistantMessageId: 99,
});

describe('renderClarify (Feishu)', () => {
  it('renders a card with one button per option, value=JSON object', () => {
    const card = renderClarify(
      { type: 'clarify', question: 'Apple or Banana?', options: ['Apple', 'Banana'] } as never,
      ctx(),
    );
    expect(card.kind).toBe('interactive');
    const c = card.card as { elements: Array<Record<string, unknown>> };
    const action = c.elements.find((e) => e.tag === 'action') as { actions: unknown[] };
    expect(action).toBeDefined();
    expect(action.actions).toHaveLength(2);
    const firstBtn = action.actions[0] as { value: unknown };
    expect(firstBtn.value).toEqual({
      action: 'clarify',
      conversationMessageId: 99,
      optionIndex: 0,
    });
    const secondBtn = action.actions[1] as { value: unknown };
    expect(secondBtn.value).toEqual({
      action: 'clarify',
      conversationMessageId: 99,
      optionIndex: 1,
    });
  });

  it('omits the action block when no options', () => {
    const card = renderClarify({ type: 'clarify', question: 'huh?' } as never, ctx());
    const c = card.card as { elements: Array<Record<string, unknown>> };
    expect(c.elements.some((e) => e.tag === 'action')).toBe(false);
  });
});
