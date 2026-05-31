import { describe, expect, it } from 'vitest';
import { createPluginTranslator } from './i18n';

describe('createPluginTranslator', () => {
  const messages = {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal placeholder syntax
    en: { greet: 'Hello ${name}', missing_var: 'Hi ${who}' },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal placeholder syntax
    zh: { greet: '你好 ${name}' },
  };

  it('translates with the requested locale', () => {
    const t = createPluginTranslator({ messages, defaultLocale: 'en' });
    expect(t.t('greet', 'zh', { name: 'Goldpan' })).toBe('你好 Goldpan');
  });

  it('falls back to defaultLocale when key missing in requested locale', () => {
    const t = createPluginTranslator({ messages, defaultLocale: 'en' });
    expect(t.t('missing_var', 'zh', { who: 'world' })).toBe('Hi world');
  });

  it('returns the code verbatim when both locales miss it', () => {
    const t = createPluginTranslator({ messages, defaultLocale: 'en' });
    expect(t.t('unknown_code', 'zh')).toBe('unknown_code');
  });

  it('falls back to the first non-empty bundle when even default missing', () => {
    const partial = { zh: { only_zh: '中文' } };
    const t = createPluginTranslator({ messages: partial, defaultLocale: 'en' });
    expect(t.t('only_zh', 'en')).toBe('中文');
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal placeholder syntax
  it('leaves ${var} placeholder visible when var undefined', () => {
    const t = createPluginTranslator({ messages, defaultLocale: 'en' });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal placeholder syntax
    expect(t.t('greet', 'en')).toBe('Hello ${name}');
  });

  it('for(locale) binds a unary function', () => {
    const t = createPluginTranslator({ messages, defaultLocale: 'en' });
    const tZh = t.for('zh');
    expect(tZh('greet', { name: 'X' })).toBe('你好 X');
  });
});
