import { describe, expect, it } from 'vitest';
import { resolveModelKeyForStep } from '../../src/llm/resolve';

describe('resolveModelKeyForStep for digest steps', () => {
  it('maps digest_summary → digestSummary', () => {
    expect(resolveModelKeyForStep('digest_summary')).toBe('digestSummary');
  });
  it('maps digest_action_parser → digestAction', () => {
    expect(resolveModelKeyForStep('digest_action_parser')).toBe('digestAction');
  });
});
