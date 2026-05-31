import { describe, expect, it } from 'vitest';
import { stripInternalKeys } from '../../src/conversation/metadata-utils';

describe('stripInternalKeys', () => {
  it('returns undefined for undefined input', () => {
    expect(stripInternalKeys(undefined)).toBeUndefined();
  });

  it('returns empty object for empty input', () => {
    expect(stripInternalKeys({})).toEqual({});
  });

  it('passes through user-visible keys', () => {
    expect(stripInternalKeys({ resultType: 'submit', sourceId: 42 })).toEqual({
      resultType: 'submit',
      sourceId: 42,
    });
  });

  it('removes __internal namespace', () => {
    const result = stripInternalKeys({
      resultType: 'submit',
      sourceId: 42,
      __internal: { classifierDecision: { intent: 'create_note' } },
    });
    expect(result).toEqual({ resultType: 'submit', sourceId: 42 });
    expect(result).not.toHaveProperty('__internal');
  });

  it('does not mutate the input object', () => {
    const input = {
      resultType: 'submit',
      __internal: { foo: 1 },
    };
    stripInternalKeys(input);
    expect(input).toHaveProperty('__internal');
  });
});
