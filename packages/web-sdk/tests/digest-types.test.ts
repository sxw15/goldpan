import { describe, expectTypeOf, it } from 'vitest';
import type { DigestChannelSlot, DigestPeriod, DigestPreset } from '../src/types';

// Mirror the core-side literal types locally so the test doesn't import @goldpan/core.
type CorePeriod = 'daily' | 'weekly';
type CoreSlot =
  | 'tracking_findings'
  | 'captures'
  | 'thoughts'
  | 'new_entities'
  | 'stats'
  | 'ai_summary';

describe('digest SDK types mirror core types', () => {
  it('period union matches', () => {
    expectTypeOf<DigestPeriod>().toEqualTypeOf<CorePeriod>();
  });
  it('channel slot union matches', () => {
    expectTypeOf<DigestChannelSlot>().toEqualTypeOf<CoreSlot>();
  });
  it('preset fields are a superset of core key fields', () => {
    const preset: DigestPreset = {
      id: 1,
      channel: 'telegram',
      name: 'x',
      period: 'daily',
      pushDay: null,
      slots: ['stats'],
      skipEmpty: true,
      includeAiSummary: true,
      isDefault: true,
    };
    expectTypeOf(preset.slots).toEqualTypeOf<DigestChannelSlot[]>();
  });
});
