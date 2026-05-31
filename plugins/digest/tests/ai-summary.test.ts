import { initI18n, resetI18n } from '@goldpan/core/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateAiSummary } from '../src/modules/ai-summary.js';

beforeEach(() => {
  resetI18n();
  initI18n('en');
});

const snapshot = {
  digestId: { channel: 'web', date: '2026-04-18', presetId: null },
  period: 'daily' as const,
  generatedAt: Date.now(),
  modules: {
    stats: { type: 'stats' as const, captures: 1, findings: 2, thoughts: 0, entities: 0 },
    tracking_findings: {
      type: 'tracking_findings' as const,
      items: [],
      hasMore: false,
      hiddenCount: 0,
    },
    captures: { type: 'captures' as const, items: [], hasMore: false, hiddenCount: 0 },
    thoughts: { type: 'thoughts' as const, items: [], hasMore: false, hiddenCount: 0 },
    new_entities: { type: 'new_entities' as const, items: [], hasMore: false, hiddenCount: 0 },
  },
};

// NB: `ServiceCallLlmFn` is Zod-typed — it returns `z.infer<T>` directly (no `response.text`).
// See monorepo/packages/core/src/plugins/types.ts and
// monorepo/plugins/tracking/src/intent-handler.ts for the canonical usage.
describe('generateAiSummary', () => {
  it('returns complete status when LLM returns a Zod-valid object', async () => {
    const callLlm = vi.fn(async () => ({
      headline: 'Day in review',
      bullets: ['a', 'b'],
      closing: '',
    }));
    const result = await generateAiSummary(snapshot, { language: 'en', callLlm });
    expect(result.status).toBe('complete');
    expect(result.text).toMatch(/Day in review/);
    expect(callLlm).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'digest_summary',
        schema: expect.anything(),
        system: expect.any(String),
        prompt: expect.any(String),
        promptHash: expect.any(String),
      }),
    );
  });

  it('falls back when callLlm rejects (Zod failures surface as thrown errors in core)', async () => {
    const callLlm = vi.fn(async () => {
      throw new Error('zod validation failed');
    });
    const result = await generateAiSummary(snapshot, { language: 'en', callLlm });
    expect(result.status).toBe('fallback');
  });

  it('falls back when callLlm throws (rate limit, transport, etc.)', async () => {
    const callLlm = vi.fn(async () => {
      throw new Error('rate limit');
    });
    const result = await generateAiSummary(snapshot, { language: 'en', callLlm });
    expect(result.status).toBe('fallback');
  });

  it('honours signal abort by returning fallback without calling LLM', async () => {
    const controller = new AbortController();
    controller.abort();
    const callLlm = vi.fn();
    const result = await generateAiSummary(snapshot, {
      language: 'en',
      callLlm,
      signal: controller.signal,
    });
    expect(result.status).toBe('fallback');
    expect(callLlm).not.toHaveBeenCalled();
  });
});
