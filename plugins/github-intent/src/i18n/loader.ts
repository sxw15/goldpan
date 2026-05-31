import { createPluginTranslator } from '@goldpan/core/plugins';
import en from './en.json' with { type: 'json' };
import zh from './zh.json' with { type: 'json' };

export type SupportedLanguage = 'en' | 'zh';
export type Translator = (code: string, vars?: Record<string, unknown>) => string;

const TRANSLATOR = createPluginTranslator({
  messages: { en, zh },
  defaultLocale: 'en',
});

export function createTranslator(language: SupportedLanguage): Translator {
  return TRANSLATOR.for(language);
}
