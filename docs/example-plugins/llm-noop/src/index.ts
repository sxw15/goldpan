import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';
import type { LlmProviderPlugin } from '@goldpan/core/plugins';

/**
 * No-op reference LlmProviderPlugin for documentation.
 *
 * Mirrors the minimal LanguageModelV3 contract — useful as a copy-from
 * starter for real provider plugins. Calls return a fixed echo response;
 * no network IO. NOT intended for production use.
 *
 * Note: real providers usually re-export an existing `@ai-sdk/*` provider
 * (e.g. `createOpenAI`, `createAnthropic`) via `createProvider()`. This
 * plugin spells out the LanguageModelV3 shape by hand to make the contract
 * obvious to readers.
 */
function makeNoopModel(modelId: string): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'noop',
    modelId,
    supportedUrls: {},
    async doGenerate(_options: LanguageModelV3CallOptions) {
      return {
        content: [{ type: 'text' as const, text: `[noop ${modelId}] echo` }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
        request: {},
        response: { id: 'noop', modelId, timestamp: new Date() },
      };
    },
    async doStream(_options: LanguageModelV3CallOptions) {
      throw new Error('llm-noop: streaming not supported');
    },
  };
}

export const goldpanPlugin: LlmProviderPlugin = {
  name: 'llm-noop',
  version: '0.1.0',
  type: 'llm-provider',
  description: 'Reference LLM provider plugin (no-op echo). Use as starter template.',
  providerId: 'noop',
  createProvider() {
    return {
      languageModel: makeNoopModel,
    };
  },
};
