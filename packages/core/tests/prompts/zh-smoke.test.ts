import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTemplateCache,
  computePromptHash,
  loadPromptTemplate,
} from '../../src/prompts/loader.js';

beforeEach(() => clearTemplateCache());

describe('Chinese prompt smoke tests', () => {
  it('loads zh classifier prompt different from en', () => {
    const en = loadPromptTemplate('classifier', 'en');
    const zh = loadPromptTemplate('classifier', 'zh');
    expect(zh).toBeTruthy();
    expect(zh).not.toBe(en);
  });

  it('loads zh system prompt templates', () => {
    const content = loadPromptTemplate('classifier-system', 'zh');
    expect(content).toBeTruthy();
    expect(content.length).toBeGreaterThan(10);
  });

  it('different language produces different prompt hash', () => {
    const enTemplate = loadPromptTemplate('classifier', 'en');
    const zhTemplate = loadPromptTemplate('classifier', 'zh');
    const enHash = computePromptHash(enTemplate);
    const zhHash = computePromptHash(zhTemplate);
    expect(enHash).not.toBe(zhHash);
  });
});
