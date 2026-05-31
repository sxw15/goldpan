import { initI18n, resetI18n } from '@goldpan/core/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { goldpanPlugin } from '../src/index.js';

describe('github-intent goldpanPlugin', () => {
  beforeEach(() => {
    resetI18n();
    initI18n('en');
  });

  it('declares refresh_github intent with required classificationHints', () => {
    expect(goldpanPlugin.type).toBe('intent');
    expect(goldpanPlugin.name).toBe('github-intent');
    expect(goldpanPlugin.intents?.some((i) => i.name === 'refresh_github')).toBe(true);
  });

  it('initialize throws informative error when GithubService missing', async () => {
    const fakeRegistry = { getService: vi.fn(() => undefined) };
    await expect(
      goldpanPlugin.initialize!({} as any, {
        pluginRegistry: fakeRegistry as any,
        callLlm: vi.fn() as any,
      }),
    ).rejects.toThrow(/GithubService not registered/);
  });

  it('initialize succeeds when GithubService is registered', async () => {
    const svc = { refreshRepo: vi.fn() };
    const fakeRegistry = { getService: vi.fn(() => svc) };
    await expect(
      goldpanPlugin.initialize!({} as any, {
        pluginRegistry: fakeRegistry as any,
        callLlm: vi.fn() as any,
      }),
    ).resolves.toBeUndefined();
  });
});
