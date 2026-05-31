import { describe, expect, test } from 'vitest';
import type { ProviderWithOptions } from '../../src/config';
import {
  inferTierFromOptions,
  REASONING_TIERS,
  type ReasoningTier,
  TIER_TO_PROVIDER_OPTIONS,
} from '../../src/llm/reasoning-tiers';

const PROVIDERS: ProviderWithOptions[] = ['anthropic', 'openai', 'google', 'deepseek'];
const NON_OFF_TIERS: ReasoningTier[] = ['low', 'medium', 'high', 'max'];

describe('TIER_TO_PROVIDER_OPTIONS', () => {
  test('off maps to null for every provider (= delete-override)', () => {
    for (const p of PROVIDERS) {
      expect(TIER_TO_PROVIDER_OPTIONS.off[p]).toBeNull();
    }
  });

  test('every non-off tier produces a non-null options object for every provider', () => {
    for (const tier of NON_OFF_TIERS) {
      for (const p of PROVIDERS) {
        const opts = TIER_TO_PROVIDER_OPTIONS[tier][p];
        expect(opts).not.toBeNull();
        expect(typeof opts).toBe('object');
        expect(Object.keys(opts ?? {}).length).toBeGreaterThan(0);
      }
    }
  });

  test('anthropic budgetTokens forms a monotonic ladder low < medium < high < max', () => {
    const get = (t: ReasoningTier) =>
      (TIER_TO_PROVIDER_OPTIONS[t].anthropic as { thinking: { budgetTokens?: number } }).thinking
        .budgetTokens;
    const low = get('low');
    const medium = get('medium');
    const high = get('high');
    const max = get('max');
    expect(low).toBeDefined();
    expect(medium).toBeDefined();
    expect(high).toBeDefined();
    expect(max).toBeDefined();
    expect(low!).toBeLessThan(medium!);
    expect(medium!).toBeLessThan(high!);
    expect(high!).toBeLessThan(max!);
  });

  test('anthropic max uses enabled+budget (portable to sonnet/haiku, not adaptive)', () => {
    // `adaptive` is only supported on claude-opus-4-6+; the explicit budget
    // form works on every model that supports thinking, including the
    // project's default sonnet-4-5 / haiku-4-5.
    expect(TIER_TO_PROVIDER_OPTIONS.max.anthropic).toEqual({
      thinking: { type: 'enabled', budgetTokens: 32000 },
    });
  });

  test('openai max uses high+reasoningSummary (xhigh is GPT-5.1-Codex-Max only)', () => {
    expect(TIER_TO_PROVIDER_OPTIONS.max.openai).toEqual({
      reasoningEffort: 'high',
      reasoningSummary: 'detailed',
    });
  });

  test('deepseek exposes its own reasoningEffort ladder (not binary)', () => {
    expect(TIER_TO_PROVIDER_OPTIONS.low.deepseek).toEqual({
      thinking: { type: 'enabled' },
      reasoningEffort: 'low',
    });
    expect(TIER_TO_PROVIDER_OPTIONS.medium.deepseek).toEqual({
      thinking: { type: 'enabled' },
      reasoningEffort: 'medium',
    });
    expect(TIER_TO_PROVIDER_OPTIONS.high.deepseek).toEqual({
      thinking: { type: 'enabled' },
      reasoningEffort: 'high',
    });
    expect(TIER_TO_PROVIDER_OPTIONS.max.deepseek).toEqual({
      thinking: { type: 'enabled' },
      reasoningEffort: 'max',
    });
  });
});

describe('inferTierFromOptions', () => {
  test('null / undefined / {} → off for every provider', () => {
    for (const p of PROVIDERS) {
      expect(inferTierFromOptions(null, p)).toBe('off');
      expect(inferTierFromOptions(undefined, p)).toBe('off');
      expect(inferTierFromOptions({}, p)).toBe('off');
    }
  });

  test('round-trip: every (tier, provider) maps to a JSON that infers back to the same tier', () => {
    // After the DeepSeek `reasoningEffort` fix, round-trip is exact for all
    // 4 providers. (Previously DeepSeek was lossy because only `thinking.type`
    // was written, collapsing the ladder to 'medium' on read-back.)
    for (const tier of REASONING_TIERS) {
      for (const p of PROVIDERS) {
        const opts = TIER_TO_PROVIDER_OPTIONS[tier][p];
        expect(inferTierFromOptions(opts as Record<string, unknown> | null, p)).toBe(tier);
      }
    }
  });

  test('anthropic disabled / adaptive recognized regardless of budget field', () => {
    expect(inferTierFromOptions({ thinking: { type: 'disabled' } }, 'anthropic')).toBe('off');
    // 'adaptive' (predates the explicit max budget) is still recognized as max
    // so legacy hand-rolled configs see Max in the dropdown, not Custom.
    expect(inferTierFromOptions({ thinking: { type: 'adaptive' } }, 'anthropic')).toBe('max');
  });

  test('anthropic budget snaps to nearest ladder rung up to 32k, above is unknown', () => {
    // Ladder rungs: 1k=low, 4k=medium, 16k=high, 32k=max. Between-rung values
    // snap up (8000 → high since 4096 < 8000 <= 16384). 50000 sits above the
    // max rung — UI shows "Custom" and locks the dropdown so a click doesn't
    // overwrite the hand-tuned value.
    expect(
      inferTierFromOptions({ thinking: { type: 'enabled', budgetTokens: 8000 } }, 'anthropic'),
    ).toBe('high');
    expect(
      inferTierFromOptions({ thinking: { type: 'enabled', budgetTokens: 25_000 } }, 'anthropic'),
    ).toBe('max');
    expect(
      inferTierFromOptions({ thinking: { type: 'enabled', budgetTokens: 50_000 } }, 'anthropic'),
    ).toBe('unknown');
  });

  test('anthropic zero / negative budget returns unknown (illegal API input)', () => {
    expect(
      inferTierFromOptions({ thinking: { type: 'enabled', budgetTokens: 0 } }, 'anthropic'),
    ).toBe('unknown');
    expect(
      inferTierFromOptions({ thinking: { type: 'enabled', budgetTokens: -100 } }, 'anthropic'),
    ).toBe('unknown');
  });

  test('openai minimal collapses to low (functionally equivalent for UI)', () => {
    expect(inferTierFromOptions({ reasoningEffort: 'minimal' }, 'openai')).toBe('low');
  });

  test('openai none maps to off (GPT-5.1 explicit off)', () => {
    expect(inferTierFromOptions({ reasoningEffort: 'none' }, 'openai')).toBe('off');
  });

  test('openai legacy xhigh still recognized as max (back-compat)', () => {
    expect(inferTierFromOptions({ reasoningEffort: 'xhigh' }, 'openai')).toBe('max');
  });

  test('openai high + reasoningSummary detailed → max', () => {
    expect(
      inferTierFromOptions({ reasoningEffort: 'high', reasoningSummary: 'detailed' }, 'openai'),
    ).toBe('max');
    expect(inferTierFromOptions({ reasoningEffort: 'high' }, 'openai')).toBe('high');
  });

  test('google includeThoughts:true bumps high to max', () => {
    expect(
      inferTierFromOptions(
        { thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } },
        'google',
      ),
    ).toBe('max');
    expect(inferTierFromOptions({ thinkingConfig: { thinkingLevel: 'high' } }, 'google')).toBe(
      'high',
    );
  });

  test('deepseek explicit disabled recognized as off', () => {
    expect(inferTierFromOptions({ thinking: { type: 'disabled' } }, 'deepseek')).toBe('off');
  });

  test('deepseek legacy enabled-only (no reasoningEffort) snaps to medium', () => {
    // Configs written before the reasoningEffort fix only set `thinking.type`.
    // Read-back snaps these to 'medium' (neutral midpoint) so the UI shows a
    // tier instead of Custom, and a user click writes the corrected shape.
    expect(inferTierFromOptions({ thinking: { type: 'enabled' } }, 'deepseek')).toBe('medium');
  });

  test('deepseek adaptive type without reasoningEffort snaps to medium (neutral)', () => {
    // 'adaptive' means "let the model decide", which has no fixed tier — UI
    // snaps to medium so the dropdown shows a value instead of Custom.
    expect(inferTierFromOptions({ thinking: { type: 'adaptive' } }, 'deepseek')).toBe('medium');
  });

  test('unrecognized shape returns unknown (UI shows "Custom" + locks dropdown)', () => {
    expect(inferTierFromOptions({ foo: 'bar' }, 'anthropic')).toBe('unknown');
    expect(inferTierFromOptions({ reasoningEffort: 'extreme' }, 'openai')).toBe('unknown');
    expect(inferTierFromOptions({ thinkingConfig: { thinkingLevel: 'extra' } }, 'google')).toBe(
      'unknown',
    );
    expect(inferTierFromOptions({ thinking: { type: 'weird' } }, 'deepseek')).toBe('unknown');
  });
});
