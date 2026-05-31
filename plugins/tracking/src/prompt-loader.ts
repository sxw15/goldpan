import path from 'node:path';
import { compilePrompt, computePromptHash, createPluginPromptLoader } from '@goldpan/core/prompts';

export const loadPluginPrompt = createPluginPromptLoader({
  dir: path.resolve(import.meta.dirname, '../prompts'),
  label: 'tracking',
});

export const compilePluginPrompt = compilePrompt;

export function computePluginPromptHash(system: string, user: string): string {
  return computePromptHash(system, user);
}
