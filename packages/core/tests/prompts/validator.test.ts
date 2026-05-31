import { describe, expect, it } from 'vitest';
import { validatePromptFiles } from '../../src/prompts/validator.js';

describe('validatePromptFiles', () => {
  it('succeeds for en with verifier disabled', () => {
    expect(() => validatePromptFiles('en')).not.toThrow();
  });

  it('succeeds for en with verifier enabled', () => {
    expect(() => validatePromptFiles('en')).not.toThrow();
  });

  it('succeeds for zh with verifier enabled', () => {
    expect(() => validatePromptFiles('zh')).not.toThrow();
  });
});
