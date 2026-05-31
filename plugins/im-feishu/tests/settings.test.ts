import { describe, expect, it, vi } from 'vitest';
// Relative import — see Task 8 step 3 for rationale (vitest no self-alias,
// package.json exports map only `.` → dist).
import { goldpanIMEnvSpec, goldpanIMSettings } from '../src/settings.js';

const silentLogger = () =>
  ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }) as any;

describe('goldpanIMSettings (feishu)', () => {
  it('manifest has channelId feishu and 3 fields + 1 action + 6 setup steps', () => {
    expect(goldpanIMSettings.manifest.channelId).toBe('feishu');
    expect(goldpanIMSettings.manifest.fields).toHaveLength(3);
    expect(goldpanIMSettings.manifest.actions).toHaveLength(1);
    expect(goldpanIMSettings.manifest.setupGuide.steps).toHaveLength(6);
  });

  it('test handler returns not_configured when credentials missing', async () => {
    const res = await goldpanIMSettings.handlers.test({
      values: { appId: '', appSecret: 'x' },
      language: 'en',
      logger: silentLogger(),
      signal: new AbortController().signal,
    });
    expect(res).toEqual({
      ok: false,
      code: 'not_configured',
      message: 'Feishu credentials not configured',
    });
  });

  it('permissions step contains the JSON code block', () => {
    const step = goldpanIMSettings.manifest.setupGuide.steps.find((s) => s.id === 'permissions');
    expect(step?.code?.language).toBe('json');
    expect(step?.code?.text).toContain('admin:app.info:readonly');
  });
});

describe('goldpanIMEnvSpec (feishu)', () => {
  it('parses enabled when both credentials and ENABLED=true', () => {
    const slice = goldpanIMEnvSpec.parse({
      GOLDPAN_IM_FEISHU_APP_ID: 'cli_x',
      GOLDPAN_IM_FEISHU_APP_SECRET: 's',
      GOLDPAN_IM_FEISHU_ENABLED: 'true',
      GOLDPAN_IM_FEISHU_DOMAIN: 'feishu.cn',
    }) as any;
    expect(slice.enabled).toBe(true);
  });

  it('warns + disables on credentials asymmetry', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const slice = goldpanIMEnvSpec.parse({
      GOLDPAN_IM_FEISHU_APP_ID: 'cli_x',
      GOLDPAN_IM_FEISHU_APP_SECRET: '',
      GOLDPAN_IM_FEISHU_ENABLED: 'true',
      GOLDPAN_IM_FEISHU_DOMAIN: 'feishu.cn',
    }) as any;
    expect(slice.enabled).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('requires both'));
    warnSpy.mockRestore();
  });
});
