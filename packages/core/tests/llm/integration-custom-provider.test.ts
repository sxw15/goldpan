import { generateText } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoldpanConfig } from '../../src/config/index.js';
import { createLlmRegistry } from '../../src/llm/registry.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { createStubConfigStore } from '../pipeline/fixtures/index.js';

function makeConfig(): GoldpanConfig {
  return {
    llm: {
      classifier: 'together:meta-llama/Llama-3-70B-Instruct-Turbo',
      extractor: 'openai:gpt-4o-mini',
      matcher: 'openai:gpt-4o-mini',
      comparator: 'openai:gpt-4o-mini',
      verifier: 'openai:gpt-4o-mini',
      verifierEnabled: false,
      intent: 'openai:gpt-4o-mini',
      query: 'openai:gpt-4o-mini',
      digestSummary: 'openai:gpt-4o-mini',
      digestAction: 'openai:gpt-4o-mini',
    },
    llmProviderOptions: {},
    embedding: {
      enabled: false,
      model: 'openai:text-embedding-3-small',
      dimensions: 0,
      batchSize: 100,
    },
    providerBaseUrls: { ollama: 'http://localhost:11434/v1' },
    relation: { enabled: false },
    customLlmProviders: [
      { id: 'together', baseUrl: 'https://api.together.xyz/v1', apiKeyEnv: 'TOGETHER_API_KEY' },
    ],
  } as unknown as GoldpanConfig;
}

describe('integration: custom OpenAI-compatible provider end-to-end', () => {
  let savedFetch: typeof globalThis.fetch;
  let savedKey: string | undefined;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    savedKey = process.env.TOGETHER_API_KEY;
    process.env.TOGETHER_API_KEY = 'tgp_integration_test';
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.TOGETHER_API_KEY;
    else process.env.TOGETHER_API_KEY = savedKey;
  });

  it('routes generateText calls to the custom provider baseUrl with Bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'cmpl-test',
          object: 'chat.completion',
          created: Date.now(),
          model: 'meta-llama/Llama-3-70B-Instruct-Turbo',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'pong' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const registry = createLlmRegistry(createStubConfigStore(makeConfig()), new PluginRegistry());
    const model = registry.languageModel('classifier');
    const { text } = await generateText({ model, prompt: 'ping' });
    expect(text).toBe('pong');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://api.together.xyz/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization ?? headers.authorization).toBe('Bearer tgp_integration_test');
  });
});
