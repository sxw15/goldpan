// Human-readable labels per Language code. Used by LLM prompts (translator
// step + manual note translation) to fill the {{targetLanguageLabel}}
// Handlebars variable. Separate from UI-side i18n keys (which live in
// apps/web/messages/*.json) — these labels are LLM-facing.
import type { Language } from './types';

export const LANGUAGE_LABEL: Record<Language, string> = {
  en: 'English',
  zh: '简体中文 (Simplified Chinese)',
};
