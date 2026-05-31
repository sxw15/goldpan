import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../src/i18n/loader.js';

describe('feishu i18n loader', () => {
  it('returns the English string for a known code', () => {
    const t = createTranslator('en');
    expect(t('callback.expired', {})).toBe('That option is no longer available.');
  });

  it('substitutes placeholders of the form dollar-brace-name', () => {
    const t = createTranslator('en');
    expect(t('text_too_long', { maxLen: 100 })).toBe(
      'Your message is too long (max 100 characters).',
    );
  });

  it('returns Chinese strings when language=zh', () => {
    const t = createTranslator('zh');
    expect(t('callback.expired', {})).toBe('该选项已失效。');
  });

  it('falls back to the code itself for unknown keys', () => {
    const t = createTranslator('en');
    expect(t('not_a_real_code', {})).toBe('not_a_real_code');
  });

  it('en/zh tables have identical key sets (parity check)', async () => {
    const en = (await import('../../src/i18n/errors.en.json', { with: { type: 'json' } })).default;
    const zh = (await import('../../src/i18n/errors.zh.json', { with: { type: 'json' } })).default;
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });
});
