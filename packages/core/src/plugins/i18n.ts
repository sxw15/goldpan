// monorepo/packages/core/src/plugins/i18n.ts
//
// Generic plugin-side runtime i18n helper. Used by plugin code (collectors,
// tool/intent handlers, IM channel adapters) to translate user-facing strings
// at call-time without binding to a process-global locale.
//
// Design notes:
// - `LocaleCode` ('en' | 'zh') is shared with the settings contribution
//   protocol (`./contribution.ts`). Widening locales is a separate effort.
// - Fallback chain: requested locale → defaultLocale → first non-empty bundle
//   → code verbatim. Visible-on-miss is preferred over silent empty string.
// - `${name}` interpolation only — no ICU MessageFormat (plugin runtime
//   strings are error messages and short labels; `next-intl` covers the
//   web-side rich case).

import type { LocaleCode } from './contribution';

export type PluginMessageBundle = Record<string, string>;

export interface PluginTranslator {
  /** Missing vars are left visible as `${name}` placeholder. */
  t(code: string, locale: LocaleCode, vars?: Record<string, unknown>): string;
  /** Binding makes it usable as a unary function passed around. */
  for(locale: LocaleCode): (code: string, vars?: Record<string, unknown>) => string;
}

export interface CreatePluginTranslatorOptions {
  messages: Partial<Record<LocaleCode, PluginMessageBundle>>;
  defaultLocale: LocaleCode;
}

export function createPluginTranslator(opts: CreatePluginTranslatorOptions): PluginTranslator {
  const { messages, defaultLocale } = opts;

  function pickTemplate(code: string, locale: LocaleCode): string | undefined {
    const direct = messages[locale]?.[code];
    if (direct !== undefined) return direct;
    const fallback = messages[defaultLocale]?.[code];
    if (fallback !== undefined) return fallback;
    for (const key of Object.keys(messages) as LocaleCode[]) {
      const v = messages[key]?.[code];
      if (v !== undefined) return v;
    }
    return undefined;
  }

  function interpolate(template: string, vars: Record<string, unknown>): string {
    return template.replace(/\$\{(\w+)\}/g, (match, key: string) => {
      const v = vars[key];
      return v === undefined || v === null ? match : String(v);
    });
  }

  const translator: PluginTranslator = {
    t(code, locale, vars) {
      const template = pickTemplate(code, locale);
      if (template === undefined) return code;
      if (vars === undefined) return template;
      return interpolate(template, vars);
    },
    for(locale) {
      return (code, vars) => translator.t(code, locale, vars);
    },
  };

  return translator;
}
