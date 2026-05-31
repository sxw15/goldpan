// apps/web/src/i18n/locales.ts
//
// Single source of truth for the UI locales the web app ships with. Both the
// next-intl request loader (request.ts) and the onboarding language picker
// read from this list so adding a new language only needs one edit here.

import webEn from '../../messages/en.json';
import webZh from '../../messages/zh.json';

export interface AvailableLocale {
  /** ISO code persisted to wizard state, env (GOLDPAN_LANGUAGE), and the
   *  `wizard-locale` cookie. */
  code: 'en' | 'zh';
  /** Native-script display name shown to the user in the language picker. */
  label: string;
}

export const AVAILABLE_LOCALES: readonly AvailableLocale[] = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: '中文' },
] as const;

export type SupportedLocale = (typeof AVAILABLE_LOCALES)[number]['code'];

export const DEFAULT_LOCALE: SupportedLocale = 'en';

export const LOCALE_MESSAGES: Record<SupportedLocale, Record<string, unknown>> = {
  en: webEn as Record<string, unknown>,
  zh: webZh as Record<string, unknown>,
};

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return (
    typeof value === 'string' && AVAILABLE_LOCALES.some((loc) => loc.code === (value as string))
  );
}
