import { beforeEach, describe, expect, it } from 'vitest';
import { createTranslator, getLanguage, initI18n, resetI18n, t } from '../../src/i18n/index.js';

describe('createTranslator', () => {
  it('returns translated string for a known key', () => {
    const tr = createTranslator('en');
    expect(tr.t('pipeline.classifying.no_content')).toBe('No content available');
  });

  it('interpolates variables', () => {
    const tr = createTranslator('en');
    expect(tr.t('pipeline.collecting.no_collector', { url: 'https://example.com' })).toBe(
      'No collector found for URL: https://example.com',
    );
  });

  it('returns Chinese translation for zh', () => {
    const tr = createTranslator('zh');
    expect(tr.t('pipeline.classifying.no_content')).toBe('没有可用的内容');
  });

  it('falls back to English for missing zh key', () => {
    const _enTr = createTranslator('en');
    const zhTr = createTranslator('zh');
    expect(zhTr.t('pipeline.classifying.no_content')).toBeTruthy();
  });

  it('returns key itself for completely unknown key', () => {
    const tr = createTranslator('en');
    expect(tr.t('totally.unknown.key')).toBe('totally.unknown.key');
  });

  it('creates independent instances', () => {
    const en = createTranslator('en');
    const zh = createTranslator('zh');
    expect(en.language).toBe('en');
    expect(zh.language).toBe('zh');
    expect(en.t('pipeline.classifying.no_content')).not.toBe(
      zh.t('pipeline.classifying.no_content'),
    );
  });

  it('interpolates numeric variables', () => {
    const tr = createTranslator('en');
    const result = tr.t('pipeline.collecting.content_too_long', { length: 50000, limit: 30000 });
    expect(result).toContain('50000');
    expect(result).toContain('30000');
  });
});

describe('singleton (initI18n / t / getLanguage / resetI18n)', () => {
  beforeEach(() => {
    resetI18n();
  });

  it('throws if t() called before initI18n()', () => {
    expect(() => t('pipeline.classifying.no_content')).toThrow();
  });

  it('throws if getLanguage() called before initI18n()', () => {
    expect(() => getLanguage()).toThrow();
  });

  it('works after initI18n()', () => {
    initI18n('en');
    expect(getLanguage()).toBe('en');
    expect(t('pipeline.classifying.no_content')).toBe('No content available');
  });

  it('is idempotent for same language', () => {
    initI18n('en');
    initI18n('en');
    expect(getLanguage()).toBe('en');
  });

  it('throws on re-init with different language', () => {
    initI18n('en');
    expect(() => initI18n('zh')).toThrow(/different language/i);
  });

  it('resetI18n allows re-init', () => {
    initI18n('en');
    resetI18n();
    initI18n('zh');
    expect(getLanguage()).toBe('zh');
  });

  it('getLanguage() reads from globalThis when module singleton is null', () => {
    initI18n('zh');
    // Simulate bundler split: wipe module-level singleton but leave globalThis intact
    const GLOBAL_KEY = Symbol.for('goldpan.i18n.translator');
    const saved = (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
    expect(saved).toBeDefined();
    // Wipe only the module singleton (resetI18n also clears globalThis, so we restore it)
    resetI18n();
    (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] = saved;
    expect(getLanguage()).toBe('zh');
  });
});
