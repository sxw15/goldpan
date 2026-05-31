import { describe, expect, it, vi } from 'vitest';
import { renderQuery } from '../../src/render/query.js';

const ctx = (overrides: Record<string, unknown> = {}) => ({
  language: 'en' as const,
  sessionRef: { channelId: 'feishu', accountId: 'cli_x', chatId: 'oc_1', userId: 'ou' },
  channelConfig: {},
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  ...overrides,
});

describe('renderQuery (Feishu card)', () => {
  it('renders a blue-header card with answer markdown', () => {
    const card = renderQuery(
      {
        type: 'query',
        query: 'what is X?',
        result: {
          answer: '**X is Y**',
          confidence: 'high',
          citedEntityIds: [],
          citedPointIds: [],
        },
      } as never,
      ctx(),
    );
    expect(card.kind).toBe('interactive');
    const c = card.card as { header: { template: string }; elements: unknown[] };
    expect(c.header.template).toBe('blue');
    expect(JSON.stringify(c.elements)).toContain('**X is Y**');
  });

  it('renders citations as plain text bullet list', () => {
    const card = renderQuery(
      {
        type: 'query',
        query: 'x',
        result: {
          answer: 'A',
          confidence: 'medium',
          citedEntityIds: [1, 2],
          citedPointIds: [],
        },
        citedEntities: [
          { id: 1, name: 'Entity A' },
          { id: 2, name: 'Entity B' },
        ],
      } as never,
      ctx(),
    );
    const json = JSON.stringify(card.card);
    expect(json).toContain('Entity A');
    expect(json).toContain('Entity B');
    expect(json).not.toContain('https://');
    expect(json).toContain('Confidence');
  });
});
