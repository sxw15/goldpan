import { validateContribution } from '@goldpan/core/plugins';
import { describe, expect, it } from 'vitest';
import { goldpanPlugin } from '../src/index';

describe('collector-browser settingsContribution', () => {
  it('declares a valid contribution', () => {
    expect(goldpanPlugin.settingsContribution).toBeDefined();
    const result = validateContribution(goldpanPlugin.settingsContribution);
    if (!result.ok) {
      throw new Error(`contribution invalid: ${JSON.stringify(result.errors)}`);
    }
  });

  it('exposes GOLDPAN_BROWSER_STRATEGY as segmented and EXECUTABLE_PATH as text', () => {
    const c = goldpanPlugin.settingsContribution;
    if (c === undefined) throw new Error('no contribution');
    const envKeys = c.fields.map((f) => f.envKey);
    expect(envKeys).toContain('GOLDPAN_BROWSER_STRATEGY');
    expect(envKeys).toContain('GOLDPAN_BROWSER_EXECUTABLE_PATH');
    const strategy = c.fields.find((f) => f.envKey === 'GOLDPAN_BROWSER_STRATEGY');
    expect(strategy?.kind).toBe('segmented');
    const path = c.fields.find((f) => f.envKey === 'GOLDPAN_BROWSER_EXECUTABLE_PATH');
    expect(path?.kind).toBe('text');
  });
});
