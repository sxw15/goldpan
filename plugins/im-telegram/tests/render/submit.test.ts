import type { RenderContext } from '@goldpan/im-runtime';
import { describe, expect, it, vi } from 'vitest';
import { renderSubmit } from '../../src/render/submit.js';

const ctx = (lang: 'en' | 'zh' = 'en'): RenderContext =>
  ({
    language: lang,
    sessionRef: { channelId: 'telegram', accountId: 'b', chatId: 'c', userId: 'u' },
    channelConfig: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  }) as never;

describe('renderSubmit', () => {
  it('accepted: shows ✅ + task id', () => {
    const out = renderSubmit(
      { type: 'submit', result: { status: 'accepted', taskId: 7, sourceId: 42 } },
      ctx(),
    );
    expect(out.text).toBe('✅ Accepted (task #7)');
    expect(out.format).toBe('plain');
  });

  it('accepted with multiple URLs: shows urlCount', () => {
    const out = renderSubmit(
      {
        type: 'submit',
        result: { status: 'accepted', taskId: 7, sourceId: 42, urlCount: 3 },
      },
      ctx(),
    );
    expect(out.text).toBe('✅ Accepted (task #7) — 3 URLs');
  });

  it('duplicate: shows ℹ️ + existing source id', () => {
    const out = renderSubmit(
      { type: 'submit', result: { status: 'duplicate', existingSourceId: 99 } },
      ctx(),
    );
    expect(out.text).toBe('ℹ️ Already saved (source #99)');
  });

  it('rejected: shows ❌ + localized reason', () => {
    const out = renderSubmit(
      {
        type: 'submit',
        result: { status: 'rejected', code: 'text_too_short', reason: 'min 4 chars' },
      },
      ctx(),
    );
    expect(out.text).toContain('❌');
    expect(out.text).toContain('too short');
  });

  it('rejected (zh): localized to chinese', () => {
    const out = renderSubmit(
      {
        type: 'submit',
        result: { status: 'rejected', code: 'url_blocked', reason: 'private IP' },
      },
      ctx('zh'),
    );
    expect(out.text).toContain('❌');
    expect(out.text).toContain('屏蔽');
  });
});
