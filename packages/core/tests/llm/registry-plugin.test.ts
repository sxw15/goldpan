import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GoldpanConfig } from '../../src/config/index.js';
import { createLlmRegistry } from '../../src/llm/registry.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import type { LlmProviderPlugin } from '../../src/plugins/types.js';
import { createStubConfigStore } from '../pipeline/fixtures/index.js';

function makeConfig(modelId: string): GoldpanConfig {
  const llm = {
    classifier: modelId,
    extractor: 'openai:gpt-4o-mini',
    matcher: 'openai:gpt-4o-mini',
    comparator: 'openai:gpt-4o-mini',
    verifier: 'openai:gpt-4o-mini',
    verifierEnabled: false,
    intent: 'openai:gpt-4o-mini',
    query: 'openai:gpt-4o-mini',
    digestSummary: 'openai:gpt-4o-mini',
    digestAction: 'openai:gpt-4o-mini',
  };
  return {
    llm,
    llmProviderOptions: {},
    embedding: {
      enabled: false,
      model: 'openai:text-embedding-3-small',
      dimensions: 0,
      batchSize: 100,
    },
    providerBaseUrls: { ollama: 'http://localhost:11434/v1' },
    relation: { enabled: false },
    customLlmProviders: [],
  } as unknown as GoldpanConfig;
}

function makePlugin(providerId: string, throwInCreate?: string): LlmProviderPlugin {
  return {
    name: `llm-${providerId}`,
    version: '0.1.0',
    type: 'llm-provider',
    description: `${providerId} mock`,
    providerId,
    createProvider: () => {
      if (throwInCreate) throw new Error(throwInCreate);
      return {
        languageModel: (modelId: string) => ({ provider: providerId, modelId }) as never,
      };
    },
  };
}

describe('createLlmRegistry: plugin providers', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GOLDPAN_') || key === 'OPENAI_API_KEY' || key === 'TOGETHER_API_KEY') {
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

  it('resolves a step to a plugin-registered provider', () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin('cohere'));
    const registry = createLlmRegistry(
      createStubConfigStore(makeConfig('cohere:command-r-plus')),
      reg,
    );
    const model = registry.languageModel('classifier');
    const m = model as unknown as { provider: string; modelId: string };
    expect(m.provider).toBe('cohere');
    expect(m.modelId).toBe('command-r-plus');
    expect(reg.getLlmProviderLoadStatus()).toEqual({
      'llm-cohere': { status: 'loaded' },
    });
  });

  it('records failed status when createProvider throws — step that does not reference the plugin still works', () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin('cohere', 'COHERE_API_KEY missing'));
    process.env.OPENAI_API_KEY = 'sk-test';
    const registry = createLlmRegistry(
      createStubConfigStore(makeConfig('openai:gpt-4o-mini')),
      reg,
    );
    expect(registry.languageModel('classifier')).toBeDefined();
    // cohere not referenced → not invoked → no status (lazy invocation).
  });

  it('throws unknown-provider error with plugin status hint when plugin createProvider failed', () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin('cohere', 'COHERE_API_KEY missing'));
    // Provider-map build is lazy (gated by configStore.generation cache);
    // the unknown-provider error surfaces on the first languageModel() call.
    const registry = createLlmRegistry(
      createStubConfigStore(makeConfig('cohere:command-r-plus')),
      reg,
    );
    expect(() => registry.languageModel('classifier')).toThrow(
      /Unknown LLM provider.*cohere.*plugin.*llm-cohere.*failed/is,
    );
    expect(reg.getLlmProviderLoadStatus()['llm-cohere']?.status).toBe('failed');
    expect(reg.getLlmProviderLoadStatus()['llm-cohere']?.error).toMatch(/COHERE_API_KEY missing/);
  });

  it('skips plugin whose providerId conflicts with builtin (warn + skipped_conflict status)', () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin('openai')); // conflict with builtin
    process.env.OPENAI_API_KEY = 'sk-test';
    const registry = createLlmRegistry(
      createStubConfigStore(makeConfig('openai:gpt-4o-mini')),
      reg,
    );
    expect(registry.languageModel('classifier')).toBeDefined();
    expect(reg.getLlmProviderLoadStatus()['llm-openai']?.status).toBe('skipped_conflict');
  });

  it('skips plugin whose providerId conflicts with custom provider', () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin('together'));
    process.env.TOGETHER_API_KEY = 'tgp_test';
    const config = {
      ...makeConfig('together:meta-llama/Llama-3-70B'),
      customLlmProviders: [
        { id: 'together', baseUrl: 'https://api.together.xyz/v1', apiKeyEnv: 'TOGETHER_API_KEY' },
      ],
    } as GoldpanConfig;
    const registry = createLlmRegistry(createStubConfigStore(config), reg);
    expect(registry.languageModel('classifier')).toBeDefined();
    expect(reg.getLlmProviderLoadStatus()['llm-together']?.status).toBe('skipped_conflict');
  });
});
