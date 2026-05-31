import { describe, expect, test } from 'vitest';
import { redactSecret } from '../../src/onboarding/redact';

describe('redactSecret', () => {
  test('short ≤6 chars → all dots', () => {
    expect(redactSecret('hi')).toBe('••••••');
    expect(redactSecret('123456')).toBe('••••••');
  });

  test('long → first3...last3', () => {
    expect(redactSecret('sk-1234567890abcdef')).toBe('sk-••••••def');
  });

  test('empty → empty', () => {
    expect(redactSecret('')).toBe('');
  });
});
