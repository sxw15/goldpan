import { describe, expect, it, vi } from 'vitest';
import { enforceCardSize, MAX_CARD_BYTES } from '../../src/render/card-size.js';

const longCard = (length: number) => ({
  kind: 'interactive' as const,
  card: {
    header: { title: { tag: 'plain_text', content: 'x' }, template: 'blue' },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: 'a'.repeat(length) } }],
  },
});

describe('enforceCardSize', () => {
  it('returns the card unchanged when under the limit', () => {
    const stubLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never;
    const card = longCard(100);
    const out = enforceCardSize(card, { logger: stubLogger });
    expect(out).toBe(card);
  });

  it('truncates the largest text block when card exceeds 25KB', () => {
    const stubLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never;
    const card = longCard(40000);
    const out = enforceCardSize(card, { logger: stubLogger });
    const json = JSON.stringify((out as { kind: string; card?: unknown }).card);
    // Small JSON overhead allowance — truncation should bring us close to
    // but not massively over the soft cap.
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(MAX_CARD_BYTES + 200);
    expect(json).toContain('truncated');
    expect(stubLogger.warn).toHaveBeenCalled();
  });

  it('truncates multibyte content based on UTF-8 byte length, not code-unit length', () => {
    const stubLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never;
    const card = {
      kind: 'interactive' as const,
      card: {
        header: { title: { tag: 'plain_text', content: 'x' }, template: 'blue' },
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: '你'.repeat(10000) } }],
      },
    };
    const out = enforceCardSize(card, { logger: stubLogger });
    expect(out).not.toBe(card);
    expect(out.kind).toBe('interactive');
    const json = JSON.stringify((out as { kind: 'interactive'; card: unknown }).card);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(MAX_CARD_BYTES + 200);
    expect(stubLogger.warn).toHaveBeenCalled();
  });

  it('falls back to a text reply when even minimal card exceeds limit', () => {
    const stubLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never;
    // Header content alone exceeds the 25KB limit — the enforcer can't
    // shrink the header, so it bails out with a text fallback.
    const huge = {
      kind: 'interactive' as const,
      card: {
        header: {
          title: { tag: 'plain_text', content: 'x'.repeat(MAX_CARD_BYTES + 10000) },
          template: 'blue',
        },
        elements: [],
      },
    };
    const out = enforceCardSize(huge, { logger: stubLogger });
    expect(out.kind).toBe('text');
    expect(stubLogger.error).toHaveBeenCalled();
  });
});
