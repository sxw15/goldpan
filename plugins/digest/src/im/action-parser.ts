import type { ServiceCallLlmFn } from '@goldpan/core/plugins';
import {
  compilePluginPrompt,
  computePluginPromptHash,
  loadPluginPrompt,
} from '../prompt-loader.js';
import { type ParsedAction, ParsedActionSchema } from './action-parser.schema.js';

export interface ParseActionDeps {
  input: string;
  language: 'en' | 'zh';
  presets: Array<{ id: number; name: string }>;
  callLlm: ServiceCallLlmFn;
  signal?: AbortSignal;
}

const LIST_FAST_PATHS = new Set([
  'list',
  'subs',
  'subscriptions',
  '订阅列表',
  '列出订阅',
  '查看订阅',
]);

export async function parseDigestAction(deps: ParseActionDeps): Promise<ParsedAction | null> {
  const trimmed = deps.input.trim().toLowerCase();
  if (LIST_FAST_PATHS.has(trimmed)) return { kind: 'list' };

  const systemTemplate = loadPluginPrompt('digest_action_parser', true);
  const userTemplate = loadPluginPrompt('digest_action_parser', false);
  const system = systemTemplate;
  const prompt = compilePluginPrompt(userTemplate, {
    presetNames: deps.presets.map((p) => p.name).join(', '),
    userInput: deps.input,
  });
  const promptHash = computePluginPromptHash(system, prompt);

  try {
    // core's callLlm is Zod-typed — it returns z.infer<schema> directly after internal
    // validation + retries. Failures (transport, validation retries exhausted) surface as
    // thrown errors; callers get `null` and can fall back to a clarifying message.
    const parsed = await deps.callLlm({
      step: 'digest_action_parser',
      schema: ParsedActionSchema,
      system,
      prompt,
      promptHash,
      signal: deps.signal,
    });
    return parsed;
  } catch {
    return null;
  }
}
