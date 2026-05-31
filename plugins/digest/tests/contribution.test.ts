import { validateContribution } from '@goldpan/core/plugins';
import { describe, expect, it } from 'vitest';
import { goldpanPlugin } from '../src/index';

describe('digest settingsContribution', () => {
  it('declares a valid contribution', () => {
    const c = goldpanPlugin.settingsContribution;
    if (c === undefined) throw new Error('no contribution');
    const result = validateContribution(c);
    if (!result.ok) throw new Error(`invalid: ${JSON.stringify(result.errors)}`);
  });

  it('exposes enabled toggle + dailyTime + maxItems', () => {
    const c = goldpanPlugin.settingsContribution;
    if (c === undefined) throw new Error('no contribution');
    // The 3 envKeys may live in `enable.envKey` (top-level toggle) or as
    // `fields[]` entries — the protocol allows both. Aggregate both shapes so
    // this assertion stays about "all 3 envKeys are exposed somewhere"
    // (intent), not about how they're structurally split (implementation
    // detail).
    const envKeys = [
      ...(c.enable?.envKey !== undefined ? [c.enable.envKey] : []),
      ...c.fields.map((f) => f.envKey),
    ];
    expect(envKeys).toContain('GOLDPAN_DIGEST_ENABLED');
    expect(envKeys).toContain('GOLDPAN_DIGEST_DAILY_TIME');
    expect(envKeys).toContain('GOLDPAN_DIGEST_MAX_ITEMS_PER_MODULE');
  });

  it('uses group "digest"', () => {
    const c = goldpanPlugin.settingsContribution;
    if (c === undefined) throw new Error('no contribution');
    expect(c.group).toBe('digest');
  });
});
