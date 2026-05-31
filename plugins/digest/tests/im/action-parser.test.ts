import { initI18n, resetI18n } from '@goldpan/core/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDigestAction } from '../../src/im/action-parser.js';

beforeEach(() => {
  resetI18n();
  initI18n('en');
});

const presets = [
  { id: 1, name: 'daily_default' },
  { id: 2, name: 'daily_compact' },
];

describe('parseDigestAction', () => {
  it('fast-paths "list" / "订阅列表"', async () => {
    const callLlm = vi.fn();
    expect(await parseDigestAction({ input: 'list', language: 'en', presets, callLlm })).toEqual({
      kind: 'list',
    });
    expect(
      await parseDigestAction({ input: '订阅列表', language: 'zh', presets, callLlm }),
    ).toEqual({
      kind: 'list',
    });
    expect(callLlm).not.toHaveBeenCalled();
  });

  it('falls back to LLM for ambiguous input (core callLlm already Zod-validates via schema)', async () => {
    const callLlm = vi.fn(async () => ({
      kind: 'subscribe',
      presetName: 'daily_default',
      pushTime: '08:30',
    }));
    const parsed = await parseDigestAction({
      input: '每天早上 8:30 给我推日报',
      language: 'zh',
      presets,
      callLlm,
    });
    expect(parsed).toEqual({ kind: 'subscribe', presetName: 'daily_default', pushTime: '08:30' });
    expect(callLlm).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'digest_action_parser',
        schema: expect.anything(),
        system: expect.any(String),
        prompt: expect.any(String),
        promptHash: expect.any(String),
      }),
    );
  });

  it('returns null when callLlm throws (core retries exhausted or transport error)', async () => {
    const callLlm = vi.fn(async () => {
      throw new Error('zod validation failed after retries');
    });
    const parsed = await parseDigestAction({
      input: 'weirdness',
      language: 'en',
      presets,
      callLlm,
    });
    expect(parsed).toBeNull();
  });
});
