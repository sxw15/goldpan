import Handlebars from 'handlebars';
import type { LlmStep } from '../db/repositories/types';
import type { Language } from '../i18n/types';
import { loadPromptTemplate, type PromptTemplateName } from './loader';

const REQUIRED_STEPS: LlmStep[] = [
  'classifier',
  'extractor',
  'matcher',
  'comparator',
  'intent_classifier',
  'query_understand',
  'query',
];

export function validatePromptFiles(language: Language): void {
  const steps: LlmStep[] = [...REQUIRED_STEPS, 'verifier', 'relator'];

  const variants: PromptTemplateName[] = [
    ...steps,
    ...steps.map((s) => `${s}-system` as PromptTemplateName),
  ];

  const errors: string[] = [];
  for (const name of variants) {
    try {
      const content = loadPromptTemplate(name, language);
      Handlebars.compile(content);
    } catch (e) {
      errors.push(`${name} (${language}): ${(e as Error).message}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Prompt validation failed:\n${errors.join('\n')}`);
  }
}
