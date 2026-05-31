import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../src/i18n/index.js';

describe('Chinese translation smoke tests', () => {
  it('zh translator produces non-empty strings', () => {
    const tr = createTranslator('zh');
    expect(tr.t('pipeline.classifying.no_content')).toBeTruthy();
    expect(tr.t('pipeline.classifying.no_content')).not.toBe('pipeline.classifying.no_content');
  });

  it('zh translations differ from en', () => {
    const en = createTranslator('en');
    const zh = createTranslator('zh');
    expect(zh.t('pipeline.classifying.no_content')).not.toBe(
      en.t('pipeline.classifying.no_content'),
    );
  });

  it('zh interpolation works', () => {
    const tr = createTranslator('zh');
    const result = tr.t('pipeline.collecting.no_collector', { url: 'https://example.com' });
    expect(result).toContain('https://example.com');
    expect(result).not.toBe('pipeline.collecting.no_collector');
  });
});
