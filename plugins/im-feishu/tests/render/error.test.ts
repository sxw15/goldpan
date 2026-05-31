import { describe, expect, it, vi } from 'vitest';
import { renderError } from '../../src/render/error.js';

const ctx = () => ({
  language: 'en' as const,
  sessionRef: { channelId: 'feishu', accountId: 'cli_x', chatId: 'oc_1', userId: 'ou' },
  channelConfig: {},
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
});

describe('renderError (Feishu)', () => {
  it('produces a red-header card with code + localized message', () => {
    const reply = renderError('text_too_long', { maxLen: 100 }, ctx());
    expect(reply.kind).toBe('interactive');
    const c = reply.card as { header: { template: string }; elements: unknown[] };
    expect(c.header.template).toBe('red');
    const json = JSON.stringify(c.elements);
    expect(json).toContain('text_too_long');
    expect(json).toContain('Your message is too long (max 100 characters)');
  });

  it('falls back gracefully on unknown error code', () => {
    const reply = renderError('not_a_real_code', { x: 1 }, ctx());
    const json = JSON.stringify(reply.card);
    expect(json).toContain('not_a_real_code');
  });
});
