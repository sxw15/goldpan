import { describe, expect, test } from 'vitest';
import { DUAL_PROCESS_RESTART_KEYS as CORE_KEYS } from '../../core/src/config/index.ts';
import { DUAL_PROCESS_RESTART_KEYS as SDK_KEYS } from '../src/types.js';

describe('DUAL_PROCESS_RESTART_KEYS web-sdk ↔ core parity', () => {
  test('arrays are identical and in the same order', () => {
    expect([...SDK_KEYS]).toEqual([...CORE_KEYS]);
  });

  test('every key is uppercase and valid env identifier', () => {
    for (const k of SDK_KEYS) {
      expect(k).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});
