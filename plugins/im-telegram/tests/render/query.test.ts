import type { RenderContext } from '@goldpan/im-runtime';
import { describe, expect, it, vi } from 'vitest';
import { renderQuery } from '../../src/render/query.js';

const ctx = (extra: Record<string, unknown> = {}, language: 'en' | 'zh' = 'en'): RenderContext =>
  ({
    language,
    sessionRef: { channelId: 'telegram', accountId: 'b', chatId: 'c', userId: 'u' },
    channelConfig: extra,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  }) as never;

describe('renderQuery', () => {
  it('renders the answer with HTML formatting', () => {
    const out = renderQuery(
      {
        type: 'query',
        query: 'q?',
        result: {
          answer: '**bold** answer',
          confidence: 'high',
          citedEntityIds: [],
          citedPointIds: [],
        },
        citedEntities: [],
      },
      ctx(),
    );
    expect(out.text).toContain('<b>bold</b>');
    expect(out.format).toBe('html');
  });

  it('appends Sources footer with plain bullet names when citedEntities present', () => {
    const out = renderQuery(
      {
        type: 'query',
        query: 'q?',
        result: {
          answer: 'a',
          confidence: 'high',
          citedEntityIds: [1, 2],
          citedPointIds: [],
        },
        citedEntities: [
          { id: 1, name: 'Alpha' },
          { id: 2, name: 'Beta' },
        ],
      },
      ctx(),
    );
    expect(out.text).toContain('• Alpha');
    expect(out.text).toContain('• Beta');
    expect(out.text).not.toContain('<a');
  });

  it('shows confidence badge for medium / low (en)', () => {
    const out = renderQuery(
      {
        type: 'query',
        query: 'q?',
        result: { answer: 'a', confidence: 'low', citedEntityIds: [], citedPointIds: [] },
        citedEntities: [],
      },
      ctx(),
    );
    expect(out.text).toMatch(/Confidence: low/);
  });

  it('localizes the confidence label and Sources heading in zh', () => {
    const out = renderQuery(
      {
        type: 'query',
        query: 'q?',
        result: {
          answer: '答案',
          confidence: 'medium',
          citedEntityIds: [1],
          citedPointIds: [],
        },
        citedEntities: [{ id: 1, name: '甲' }],
      },
      ctx({}, 'zh'),
    );
    expect(out.text).toContain('置信度: medium');
    expect(out.text).toContain('来源');
  });
});
