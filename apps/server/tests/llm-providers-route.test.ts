import type { GoldpanConfig } from '@goldpan/core/config';
import type { LlmProviderPlugin } from '@goldpan/core/plugins';
import { PluginRegistry } from '@goldpan/core/plugins';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLlmProvidersSnapshot } from '../src/routes/llm-providers.js';

function makePlugin(providerId: string): LlmProviderPlugin {
  return {
    name: `llm-${providerId}`,
    version: '0.1.0',
    type: 'llm-provider',
    description: `${providerId} mock`,
    providerId,
    createProvider: () => ({ languageModel: () => ({}) as never }),
  };
}

const baseConfig = {
  customLlmProviders: [],
  ollamaEnabled: false,
  providerModels: {},
  providerEmbeddingModels: {},
} as unknown as GoldpanConfig;

describe('GET /settings/llm-providers snapshot', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const key of [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'DEEPSEEK_API_KEY',
      'OPENROUTER_API_KEY',
      'TOGETHER_API_KEY',
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('reports builtin providers with apiKeyConfigured flag', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const snap = buildLlmProvidersSnapshot(baseConfig, new PluginRegistry());
    expect(snap.builtin).toEqual(
      expect.arrayContaining([
        {
          id: 'openai',
          apiKeyEnv: 'OPENAI_API_KEY',
          apiKeyConfigured: true,
          models: [],
          embeddingModels: [],
        },
        {
          id: 'anthropic',
          apiKeyEnv: 'ANTHROPIC_API_KEY',
          apiKeyConfigured: false,
          models: [],
          embeddingModels: [],
        },
        {
          id: 'google',
          apiKeyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY',
          apiKeyConfigured: false,
          models: [],
          embeddingModels: [],
        },
        {
          id: 'deepseek',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          apiKeyConfigured: false,
          models: [],
          embeddingModels: [],
        },
        // Ollama is opt-in via ollamaEnabled (was: always-on builtin). Default `false`
        // here mirrors GOLDPAN_OLLAMA_ENABLED's default — ollama stays out of the
        // Pipeline dropdown until the user explicitly switches it on.
        {
          id: 'ollama',
          apiKeyEnv: '',
          apiKeyConfigured: false,
          models: [],
          embeddingModels: [],
        },
        {
          id: 'openrouter',
          apiKeyEnv: 'OPENROUTER_API_KEY',
          apiKeyConfigured: false,
          models: [],
          embeddingModels: [],
        },
      ]),
    );
  });

  it('flips ollama apiKeyConfigured to true when ollamaEnabled', () => {
    const config = { ...baseConfig, ollamaEnabled: true } as GoldpanConfig;
    const snap = buildLlmProvidersSnapshot(config, new PluginRegistry());
    const ollama = snap.builtin.find((b) => b.id === 'ollama');
    expect(ollama).toEqual({
      id: 'ollama',
      apiKeyEnv: '',
      apiKeyConfigured: true,
      models: [],
      embeddingModels: [],
    });
  });

  it('exposes provider models on builtin rows from providerModels map', () => {
    const config = {
      ...baseConfig,
      ollamaEnabled: true,
      providerModels: {
        ollama: ['llama3.2:8b', 'qwen2.5:7b'],
        anthropic: ['claude-sonnet-4-5-20250929'],
      },
    } as GoldpanConfig;
    const snap = buildLlmProvidersSnapshot(config, new PluginRegistry());
    const ollama = snap.builtin.find((b) => b.id === 'ollama');
    expect(ollama?.models).toEqual(['llama3.2:8b', 'qwen2.5:7b']);
    const anthropic = snap.builtin.find((b) => b.id === 'anthropic');
    expect(anthropic?.models).toEqual(['claude-sonnet-4-5-20250929']);
    const openai = snap.builtin.find((b) => b.id === 'openai');
    expect(openai?.models).toEqual([]);
  });

  it('lists custom providers with their configured key', () => {
    process.env.TOGETHER_API_KEY = 'tgp_test';
    const config = {
      ...baseConfig,
      customLlmProviders: [
        {
          id: 'together',
          baseUrl: 'https://api.together.xyz/v1',
          apiKeyEnv: 'TOGETHER_API_KEY',
          models: ['llama-3.3-70b-instruct-turbo'],
        },
      ],
    } as GoldpanConfig;
    const snap = buildLlmProvidersSnapshot(config, new PluginRegistry());
    expect(snap.custom).toEqual([
      {
        id: 'together',
        baseUrl: 'https://api.together.xyz/v1',
        apiKeyEnv: 'TOGETHER_API_KEY',
        apiKeyConfigured: true,
        models: ['llama-3.3-70b-instruct-turbo'],
        embeddingModels: [],
      },
    ]);
  });

  it('lists plugin providers with status (loaded / failed / skipped_conflict)', () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin('cohere'));
    reg.register(makePlugin('bedrock'));
    reg.recordLlmProviderStatus('llm-cohere', { status: 'loaded' });
    reg.recordLlmProviderStatus('llm-bedrock', { status: 'failed', error: 'AWS_REGION missing' });
    const snap = buildLlmProvidersSnapshot(baseConfig, reg);
    expect(snap.plugin).toEqual(
      expect.arrayContaining([
        {
          providerId: 'cohere',
          pluginName: 'llm-cohere',
          status: 'loaded',
          models: [],
          embeddingModels: [],
        },
        {
          providerId: 'bedrock',
          pluginName: 'llm-bedrock',
          status: 'failed',
          error: 'AWS_REGION missing',
          models: [],
          embeddingModels: [],
        },
      ]),
    );
  });

  it('exposes providerModels on plugin rows', () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin('cohere'));
    const config = {
      ...baseConfig,
      providerModels: { cohere: ['command-r-plus'] },
    } as GoldpanConfig;
    const snap = buildLlmProvidersSnapshot(config, reg);
    expect(snap.plugin).toEqual([
      {
        providerId: 'cohere',
        pluginName: 'llm-cohere',
        status: 'loaded',
        models: ['command-r-plus'],
        embeddingModels: [],
      },
    ]);
  });

  it('reports plugin without recorded status as "loaded" if registered (default optimistic)', () => {
    const reg = new PluginRegistry();
    reg.register(makePlugin('xai'));
    const snap = buildLlmProvidersSnapshot(baseConfig, reg);
    expect(snap.plugin).toEqual([
      {
        providerId: 'xai',
        pluginName: 'llm-xai',
        status: 'loaded',
        models: [],
        embeddingModels: [],
      },
    ]);
  });
});
