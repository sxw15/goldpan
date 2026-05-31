import { beforeEach, describe, expect, it } from 'vitest';
import { getLanguage, initI18n, resetI18n, t } from '../../src/i18n/index.js';
import { clearTemplateCache, loadPromptTemplate } from '../../src/prompts/loader.js';

describe('zh pipeline integration', () => {
  beforeEach(() => {
    resetI18n();
    clearTemplateCache();
  });

  it('initializes i18n with zh and produces translated pipeline messages', () => {
    initI18n('zh');
    expect(getLanguage()).toBe('zh');
    const noContent = t('pipeline.classifying.no_content');
    expect(noContent).not.toBe('pipeline.classifying.no_content');
    expect(noContent).not.toBe('No content available');
    const schemaValidation = t('llm.schema_validation', { step: 'test', message: 'err' });
    expect(schemaValidation).not.toBe('llm.schema_validation');
  });

  it('loads zh prompt templates that differ from en', () => {
    initI18n('zh');
    const enTemplate = loadPromptTemplate('classifier-system', 'en');
    const zhTemplate = loadPromptTemplate('classifier-system', 'zh');
    expect(zhTemplate).toBeTruthy();
    expect(zhTemplate).not.toBe(enTemplate);
  });

  it('exercises pipeline step error paths with zh translations', () => {
    initI18n('zh');
    const keys = [
      'pipeline.classifying.no_content',
      'pipeline.collecting.no_collector',
      'pipeline.extracting.no_content',
      'pipeline.matching.compilation_failed',
      'pipeline.comparing.no_matching_output',
    ];
    for (const key of keys) {
      const value = t(key);
      expect(value).not.toBe(key);
      expect(value.length).toBeGreaterThan(0);
    }
  });
});
