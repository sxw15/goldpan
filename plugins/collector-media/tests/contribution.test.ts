import { validateContribution } from '@goldpan/core/plugins';
import { describe, expect, it } from 'vitest';
import { goldpanPlugin } from '../src/index';

describe('collector-media settingsContribution', () => {
  it('declares a valid contribution', () => {
    expect(goldpanPlugin.settingsContribution).toBeDefined();
    const result = validateContribution(goldpanPlugin.settingsContribution);
    if (!result.ok) {
      throw new Error(`contribution invalid: ${JSON.stringify(result.errors)}`);
    }
  });

  it('exposes timeout / auto-update / binary path / cookies path', () => {
    const c = goldpanPlugin.settingsContribution;
    if (c === undefined) throw new Error('no contribution');
    const envKeys = c.fields.map((f) => f.envKey);
    expect(envKeys).toContain('GOLDPAN_MEDIA_COLLECT_TIMEOUT');
    expect(envKeys).toContain('GOLDPAN_YT_DLP_AUTO_UPDATE');
    expect(envKeys).toContain('GOLDPAN_YT_DLP_BINARY_PATH');
    expect(envKeys).toContain('GOLDPAN_YT_DLP_COOKIES_PATH');
  });
});
