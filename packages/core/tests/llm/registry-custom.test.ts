import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GoldpanConfig } from '../../src/config/index.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { createStubConfigStore } from '../pipeline/fixtures/index.js';

function makeConfig(overrides: {
  llm?: Partial<GoldpanConfig['llm']>;
  customLlmProviders?: GoldpanConfig['customLlmProviders'];
}): GoldpanConfig {
  return {
    llm: {
      classifier: 'openai:gpt-4o-mini',
      extractor: 'openai:gpt-4o-mini',
      matcher: 'openai:gpt-4o-mini',
      comparator: 'openai:gpt-4o-mini',
      verifier: 'openai:gpt-4o-mini',
      verifierEnabled: false,
      intent: 'openai:gpt-4o-mini',
      query: 'openai:gpt-4o-mini',
      digestSummary: 'openai:gpt-4o-mini',
      digestAction: 'openai:gpt-4o-mini',
      ...overrides.llm,
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
    customLlmProviders: overrides.customLlmProviders ?? [],
  } as unknown as GoldpanConfig;
}

describe('createLlmRegistry: custom providers', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (
        key.startsWith('GOLDPAN_') ||
        key === 'TOGETHER_API_KEY' ||
        key === 'MISTRAL_API_KEY' ||
        key === 'OPENROUTER_API_KEY' ||
        key === 'OPENAI_API_KEY' ||
        key === 'DEEPSEEK_API_KEY'
      ) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('resolves a step to a configured custom provider', async () => {
    process.env.TOGETHER_API_KEY = 'tgp_test';
    const { createLlmRegistry } = await import('../../src/llm/registry.js');
    const registry = createLlmRegistry(
      createStubConfigStore(
        makeConfig({
          llm: { classifier: 'together:meta-llama/Llama-3-70B-Instruct-Turbo' },
          customLlmProviders: [
            {
              id: 'together',
              baseUrl: 'https://api.together.xyz/v1',
              apiKeyEnv: 'TOGETHER_API_KEY',
            },
          ],
        }),
      ),
      new PluginRegistry(),
    );
    const model = registry.languageModel('classifier');
    expect(model).toBeDefined();
    const m = model as unknown as { provider: string; modelId: string };
    expect(m.provider).toContain('together');
    expect(m.modelId).toBe('meta-llama/Llama-3-70B-Instruct-Turbo');
  });

  it('only instantiates custom providers that are referenced by some step', async () => {
    process.env.TOGETHER_API_KEY = 'tgp_test';
    // intentionally NOT setting MISTRAL_API_KEY — if mistral were eagerly
    // constructed despite being unreferenced, buildCustomProviderFactory would
    // throw "requires env var" and this test would fail.
    const { createLlmRegistry } = await import('../../src/llm/registry.js');
    const registry = createLlmRegistry(
      createStubConfigStore(
        makeConfig({
          llm: { classifier: 'together:meta-llama/Llama-3-70B' },
          customLlmProviders: [
            {
              id: 'together',
              baseUrl: 'https://api.together.xyz/v1',
              apiKeyEnv: 'TOGETHER_API_KEY',
            },
            {
              id: 'mistral',
              baseUrl: 'https://api.mistral.ai/v1',
              apiKeyEnv: 'MISTRAL_API_KEY',
            },
          ],
        }),
      ),
      new PluginRegistry(),
    );
    expect(registry.languageModel('classifier')).toBeDefined();
  });

  it('throws when step references an undeclared provider', async () => {
    const { createLlmRegistry } = await import('../../src/llm/registry.js');
    // Provider-map build is lazy (gated by configStore.generation cache);
    // the unknown-provider error surfaces on the first languageModel() call.
    const registry = createLlmRegistry(
      createStubConfigStore(
        makeConfig({
          llm: {
            classifier: 'unknown:foo',
            extractor: 'unknown:foo',
            matcher: 'unknown:foo',
            comparator: 'unknown:foo',
            verifier: 'unknown:foo',
            intent: 'unknown:foo',
            query: 'unknown:foo',
            digestSummary: 'unknown:foo',
            digestAction: 'unknown:foo',
          },
        }),
      ),
      new PluginRegistry(),
    );
    expect(() => registry.languageModel('classifier')).toThrow(/unknown.*provider/i);
  });

  it('ignores per-step OPTIONS for custom providers (v1 unchanged guard)', async () => {
    process.env.TOGETHER_API_KEY = 'tgp_test';
    const { createLlmRegistry } = await import('../../src/llm/registry.js');
    const registry = createLlmRegistry(
      createStubConfigStore({
        ...makeConfig({
          llm: { classifier: 'together:meta-llama/Llama-3-70B' },
          customLlmProviders: [
            {
              id: 'together',
              baseUrl: 'https://api.together.xyz/v1',
              apiKeyEnv: 'TOGETHER_API_KEY',
            },
          ],
        }),
        llmProviderOptions: {
          classifier: { together: { reasoning: { effort: 'high' } } } as never,
        },
      } as GoldpanConfig),
      new PluginRegistry(),
    );
    const model = registry.languageModel('classifier');
    const m = model as unknown as { provider: string; modelId: string };
    expect(m.provider).toContain('together');
    expect(m.modelId).toBe('meta-llama/Llama-3-70B');
  });
});
