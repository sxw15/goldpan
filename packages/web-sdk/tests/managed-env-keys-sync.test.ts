import { describe, expect, test } from 'vitest';
import { MANAGED_ENV_KEYS as CORE_KEYS } from '../../core/src/onboarding/env-file.ts';
import { MANAGED_ENV_KEYS as SDK_KEYS } from '../src/types.js';

describe('MANAGED_ENV_KEYS web-sdk ↔ core parity', () => {
  test('arrays are identical and in the same order', () => {
    expect([...SDK_KEYS]).toEqual([...CORE_KEYS]);
  });

  test('every key is uppercase and valid env identifier', () => {
    for (const k of SDK_KEYS) {
      expect(k).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});
