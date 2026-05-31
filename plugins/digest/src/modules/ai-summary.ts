import type { ServiceCallLlmFn } from '@goldpan/core/plugins';
import {
  compilePluginPrompt,
  computePluginPromptHash,
  loadPluginPrompt,
} from '../prompt-loader.js';
import type { AiSummaryData, DataSnapshot } from '../types.js';
import { AiSummaryPayload, type AiSummaryPayloadT } from './ai-summary.schema.js';

export interface AiSummaryDeps {
  language: 'en' | 'zh';
  callLlm?: ServiceCallLlmFn;
  signal?: AbortSignal;
}

const EMPTY_FALLBACK: AiSummaryData = { status: 'fallback', text: '' };

export async function generateAiSummary(
  snapshot: Omit<DataSnapshot, 'aiSummary'>,
  deps: AiSummaryDeps,
): Promise<AiSummaryData> {
  if (!deps.callLlm) return EMPTY_FALLBACK;
  if (deps.signal?.aborted) return EMPTY_FALLBACK;
  const systemTemplate = loadPluginPrompt('digest_summary', true);
  const userTemplate = loadPluginPrompt('digest_summary', false);
  const system = systemTemplate;
  const prompt = compilePluginPrompt(userTemplate, {
    snapshotJson: JSON.stringify(snapshot),
  });
  const promptHash = computePluginPromptHash(system, prompt);
  try {
    // core's callLlm is Zod-typed: it validates against `schema` and returns `z.infer<T>`
    // directly. Failures (transport, validation retries exhausted) surface as thrown errors.
    const payload = (await deps.callLlm({
      step: 'digest_summary',
      schema: AiSummaryPayload,
      system,
      prompt,
      promptHash,
      signal: deps.signal,
    })) as AiSummaryPayloadT;
    const lines = [payload.headline, '', ...payload.bullets.map((b) => `- ${b}`)];
    if (payload.closing) lines.push('', payload.closing);
    return { status: 'complete', text: lines.join('\n') };
  } catch {
    return EMPTY_FALLBACK;
  }
}
