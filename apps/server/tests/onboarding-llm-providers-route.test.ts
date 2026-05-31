import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOnboardingLlmProvidersSnapshot } from '../src/routes/onboarding/llm-providers.js';

describe('GET /onboarding/llm-providers snapshot', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const k of [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'DEEPSEEK_API_KEY',
      'OPENROUTER_API_KEY',
      'TOGETHER_API_KEY',
      'GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL',
      'GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV',
      'GOLDPAN_LLM_PROVIDER_TOGETHER_MODELS',
      'GOLDPAN_LLM_PROVIDER_COHERE_MODELS',
      'GOLDPAN_LLM_PROVIDER_OPENAI_MODELS',
    ]) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('returns builtin entries with apiKeyConfigured', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const snap = await buildOnboardingLlmProvidersSnapshot({
      scanPlugins: async () => [],
    });
    expect(snap.builtin).toEqual(
      expect.arrayContaining([
        { id: 'openai', apiKeyEnv: 'OPENAI_API_KEY', apiKeyConfigured: true, models: [] },
        { id: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', apiKeyConfigured: false, models: [] },
        {
          id: 'google',
          apiKeyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY',
          apiKeyConfigured: false,
          models: [],
        },
        { id: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY', apiKeyConfigured: false, models: [] },
        { id: 'ollama', apiKeyEnv: '', apiKeyConfigured: true, models: [] },
        { id: 'openrouter', apiKeyEnv: 'OPENROUTER_API_KEY', apiKeyConfigured: false, models: [] },
      ]),
    );
  });

  it('parses custom providers from process.env', async () => {
    process.env.GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL = 'https://api.together.xyz/v1';
    process.env.GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV = 'TOGETHER_API_KEY';
    process.env.GOLDPAN_LLM_PROVIDER_TOGETHER_MODELS = 'llama-3.3-70b, mixtral-8x7b';
    process.env.TOGETHER_API_KEY = 'tgp_test';
    const snap = await buildOnboardingLlmProvidersSnapshot({
      scanPlugins: async () => [],
    });
    expect(snap.custom).toEqual([
      {
        id: 'together',
        baseUrl: 'https://api.together.xyz/v1',
        apiKeyEnv: 'TOGETHER_API_KEY',
        apiKeyConfigured: true,
        models: ['llama-3.3-70b', 'mixtral-8x7b'],
      },
    ]);
  });

  it('returns scanned plugins with status="loaded" (lazy/optimistic)', async () => {
    process.env.GOLDPAN_LLM_PROVIDER_COHERE_MODELS = 'command-r-plus';
    const snap = await buildOnboardingLlmProvidersSnapshot({
      scanPlugins: async () => [{ name: 'llm-cohere', providerId: 'cohere' }],
    });
    expect(snap.plugin).toEqual([
      {
        providerId: 'cohere',
        pluginName: 'llm-cohere',
        status: 'loaded',
        models: ['command-r-plus'],
      },
    ]);
  });

  it('returns empty plugin array when scan throws', async () => {
    const snap = await buildOnboardingLlmProvidersSnapshot({
      scanPlugins: async () => {
        throw new Error('scan-fail');
      },
    });
    expect(snap.plugin).toEqual([]);
  });
});
