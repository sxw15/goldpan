import en from './locales/en.json' with { type: 'json' };
import zh from './locales/zh.json' with { type: 'json' };
import type { Language } from './types';

export { resolveLanguageLock } from './language-lock';
export type { Language } from './types';

type NestedRecord = { [key: string]: string | NestedRecord };

const locales: Record<Language, NestedRecord> = { en, zh };

function deepMerge(base: NestedRecord, overlay: NestedRecord): NestedRecord {
  const result = { ...base };
  for (const key of Object.keys(overlay)) {
    const baseVal = base[key];
    const overlayVal = overlay[key];
    if (
      typeof baseVal === 'object' &&
      baseVal !== null &&
      typeof overlayVal === 'object' &&
      overlayVal !== null
    ) {
      result[key] = deepMerge(baseVal as NestedRecord, overlayVal as NestedRecord);
    } else {
      result[key] = overlayVal;
    }
  }
  return result;
}

function lookupKey(obj: NestedRecord, key: string): string | undefined {
  const parts = key.split('.');
  let current: NestedRecord | string = obj;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as NestedRecord)[part];
    if (current === undefined) return undefined;
  }
  return typeof current === 'string' ? current : undefined;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const val = vars[name];
    return val !== undefined ? String(val) : match;
  });
}

export interface Translator {
  t(key: string, vars?: Record<string, string | number>): string;
  language: Language;
}

export function createTranslator(language: Language): Translator {
  const merged = language === 'en' ? locales.en : deepMerge(locales.en, locales[language]);
  return {
    language,
    t(key: string, vars?: Record<string, string | number>): string {
      const value = lookupKey(merged, key);
      if (value === undefined) {
        console.warn(`[i18n] Missing translation key: "${key}"`);
        return key;
      }
      return interpolate(value, vars);
    },
  };
}

let singleton: Translator | null = null;

// Symbol.for() returns the same symbol across module instances, allowing the
// translator to survive vi.resetModules() in tests (which wipes the module
// cache but not globalThis).
const GLOBAL_KEY = Symbol.for('goldpan.i18n.translator');

export function initI18n(language: Language): void {
  if (singleton) {
    if (singleton.language === language) return;
    throw new Error(
      `initI18n() already called with '${singleton.language}', cannot re-init with different language '${language}'. Call resetI18n() first (testing only).`,
    );
  }
  singleton = createTranslator(language);
  (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] = singleton;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  if (!singleton) {
    const global = (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] as Translator | undefined;
    if (global) {
      singleton = global;
      return singleton.t(key, vars);
    }
    throw new Error('i18n not initialized. Call initI18n() at startup before using t().');
  }
  return singleton.t(key, vars);
}

export function getLanguage(): Language {
  if (!singleton) {
    const global = (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] as Translator | undefined;
    if (global) {
      singleton = global;
      return singleton.language;
    }
    throw new Error('i18n not initialized. Call initI18n() at startup before using getLanguage().');
  }
  return singleton.language;
}

export function resetI18n(): void {
  singleton = null;
  delete (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
}
