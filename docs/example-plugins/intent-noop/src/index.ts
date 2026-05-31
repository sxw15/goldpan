// Example intent plugin skeleton. Declares a single intent `echo` that
// returns the user's input verbatim as content. Real intent plugins fan out
// to LLM or query subsystems via `ctx.callLlm` / `ctx.repos.knowledge`; this
// example keeps the body trivial so the protocol shape stays the focus.
//
// resultTypes on the declaration tells handleInput which IntentPluginResult
// variants this intent may return. Mismatches fail loudly at runtime.

import type {
  IntentDeclaration,
  IntentExecutionContext,
  IntentPlugin,
  IntentPluginResult,
} from '@goldpan/core/plugins';

const declaration: IntentDeclaration = {
  name: 'echo',
  description: 'Echo the user input back.',
  descriptions: { zh: '把用户输入原样回显。' },
  examples: ['echo: hello world', 'say back: anything'],
  classificationHints: [
    'Pick this when the user explicitly asks the assistant to echo or repeat their input.',
  ],
  priority: -100,
  resultTypes: ['content'],
};

export const goldpanPlugin: IntentPlugin = {
  name: 'intent-noop',
  version: '0.0.1',
  type: 'intent',
  description: 'Example intent — echoes user input',
  intents: [declaration],
  execute: async (
    intentName: string,
    input: string,
    _ctx: IntentExecutionContext,
  ): Promise<IntentPluginResult> => {
    if (intentName !== 'echo') throw new Error(`Unknown intent: ${intentName}`);
    return { type: 'content', text: `You said: ${input}`, format: 'text' };
  },
};
