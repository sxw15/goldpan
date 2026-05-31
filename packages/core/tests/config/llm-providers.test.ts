import { describe, expect, it } from 'vitest';
import { parseCustomLlmProviders, parseProviderModels } from '../../src/config/llm-providers.js';

describe('parseCustomLlmProviders', () => {
  it('returns empty array when no GOLDPAN_LLM_PROVIDER_*_BASE_URL keys present', () => {
    expect(parseCustomLlmProviders({})).toEqual([]);
  });

  it('parses a single custom provider', () => {
    const env = {
      GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL: 'https://api.together.xyz/v1',
      GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV: 'TOGETHER_API_KEY',
      TOGETHER_API_KEY: 'tgp_xxx',
    };
    expect(parseCustomLlmProviders(env)).toEqual([
      {
        id: 'together',
        baseUrl: 'https://api.together.xyz/v1',
        apiKeyEnv: 'TOGETHER_API_KEY',
        models: [],
      },
    ]);
  });

  it('parses _MODELS into a trimmed array (comma-separated)', () => {
    const env = {
      GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL: 'https://api.together.xyz/v1',
      GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV: 'TOGETHER_API_KEY',
      GOLDPAN_LLM_PROVIDER_TOGETHER_MODELS: 'llama-3.3-70b-instruct, mixtral-8x7b ,, ',
      TOGETHER_API_KEY: 'tgp_xxx',
    };
    expect(parseCustomLlmProviders(env)).toEqual([
      {
        id: 'together',
        baseUrl: 'https://api.together.xyz/v1',
        apiKeyEnv: 'TOGETHER_API_KEY',
        models: ['llama-3.3-70b-instruct', 'mixtral-8x7b'],
      },
    ]);
  });

  it('parses multiple custom providers (lexicographically sorted)', () => {
    const env = {
      GOLDPAN_LLM_PROVIDER_MISTRAL_BASE_URL: 'https://api.mistral.ai/v1',
      GOLDPAN_LLM_PROVIDER_MISTRAL_API_KEY_ENV: 'MISTRAL_API_KEY',
      MISTRAL_API_KEY: 'mistral-xxx',
      GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL: 'https://api.together.xyz/v1',
      GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV: 'TOGETHER_API_KEY',
      TOGETHER_API_KEY: 'tgp_xxx',
    };
    const result = parseCustomLlmProviders(env);
    expect(result.map((p) => p.id)).toEqual(['mistral', 'together']);
  });

  it('throws when GOLDPAN_LLM_PROVIDER_<ID>_API_KEY_ENV is missing', () => {
    const env = {
      GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL: 'https://api.together.xyz/v1',
    };
    expect(() => parseCustomLlmProviders(env)).toThrow(/TOGETHER.*API_KEY_ENV/);
  });

  it('throws when apiKeyEnv references a missing env var', () => {
    const env = {
      GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL: 'https://api.together.xyz/v1',
      GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV: 'TOGETHER_API_KEY',
      // no TOGETHER_API_KEY
    };
    expect(() => parseCustomLlmProviders(env)).toThrow(/TOGETHER_API_KEY.*not set/);
  });

  it('throws when id collides with builtin (openai)', () => {
    const env = {
      GOLDPAN_LLM_PROVIDER_OPENAI_BASE_URL: 'https://api.example.com/v1',
      GOLDPAN_LLM_PROVIDER_OPENAI_API_KEY_ENV: 'EXAMPLE_KEY',
      EXAMPLE_KEY: 'x',
    };
    expect(() => parseCustomLlmProviders(env)).toThrow(/openai.*reserved.*builtin/i);
  });

  it('throws when id collides with builtin (each of anthropic/google/deepseek/ollama/openrouter)', () => {
    for (const builtin of ['anthropic', 'google', 'deepseek', 'ollama', 'openrouter']) {
      const upper = builtin.toUpperCase();
      const env = {
        [`GOLDPAN_LLM_PROVIDER_${upper}_BASE_URL`]: 'https://api.example.com/v1',
        [`GOLDPAN_LLM_PROVIDER_${upper}_API_KEY_ENV`]: 'EXAMPLE_KEY',
        EXAMPLE_KEY: 'x',
      };
      expect(() => parseCustomLlmProviders(env)).toThrow(
        new RegExp(`${builtin}.*reserved.*builtin`, 'i'),
      );
    }
  });

  it('throws when baseUrl is not a URL', () => {
    const env = {
      GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL: 'not-a-url',
      GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV: 'TOGETHER_API_KEY',
      TOGETHER_API_KEY: 'tgp_xxx',
    };
    expect(() => parseCustomLlmProviders(env)).toThrow(/baseUrl/i);
  });

  it('throws when apiKeyEnv has invalid env var name (lowercase / dashes)', () => {
    const env = {
      GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL: 'https://api.together.xyz/v1',
      GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV: 'together-api-key',
      'together-api-key': 'x',
    };
    expect(() => parseCustomLlmProviders(env)).toThrow(/apiKeyEnv/i);
  });

  it('parses underscore provider ids as literal underscore ids', () => {
    const env = {
      GOLDPAN_LLM_PROVIDER_TOGETHER_AI_BASE_URL: 'https://api.together.xyz/v1',
      GOLDPAN_LLM_PROVIDER_TOGETHER_AI_API_KEY_ENV: 'TOGETHER_AI_API_KEY',
      TOGETHER_AI_API_KEY: 'tgp_xxx',
    };
    expect(parseCustomLlmProviders(env)).toEqual([
      {
        id: 'together_ai',
        baseUrl: 'https://api.together.xyz/v1',
        apiKeyEnv: 'TOGETHER_AI_API_KEY',
        models: [],
      },
    ]);
  });

  it('ignores partial entries that lack the BASE_URL key (no implicit binding)', () => {
    const env = {
      GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV: 'TOGETHER_API_KEY',
      TOGETHER_API_KEY: 'tgp_xxx',
    };
    expect(parseCustomLlmProviders(env)).toEqual([]);
  });
});

describe('parseProviderModels', () => {
  it('returns empty map when no _MODELS keys present', () => {
    expect(parseProviderModels({})).toEqual({});
  });

  it('parses _MODELS keys for any provider id (builtin and custom alike)', () => {
    expect(
      parseProviderModels({
        GOLDPAN_LLM_PROVIDER_ANTHROPIC_MODELS:
          'claude-sonnet-4-5-20250929, claude-haiku-4-5-20251001',
        GOLDPAN_LLM_PROVIDER_OPENAI_MODELS: 'gpt-4o,gpt-4o-mini',
        GOLDPAN_LLM_PROVIDER_TOGETHER_MODELS: 'meta-llama/Llama-3-70B-Instruct-Turbo',
      }),
    ).toEqual({
      anthropic: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'],
      openai: ['gpt-4o', 'gpt-4o-mini'],
      together: ['meta-llama/Llama-3-70B-Instruct-Turbo'],
    });
  });

  it('drops empty / whitespace-only entries inside the comma list', () => {
    expect(
      parseProviderModels({
        GOLDPAN_LLM_PROVIDER_ANTHROPIC_MODELS: 'a, ,, b ,  ',
      }),
    ).toEqual({ anthropic: ['a', 'b'] });
  });

  it('skips empty values entirely (no key created)', () => {
    expect(
      parseProviderModels({
        GOLDPAN_LLM_PROVIDER_ANTHROPIC_MODELS: '',
        GOLDPAN_LLM_PROVIDER_OPENAI_MODELS: '   ,  ,',
      }),
    ).toEqual({});
  });

  it('lowercases provider ids in the resulting map', () => {
    expect(parseProviderModels({ GOLDPAN_LLM_PROVIDER_GROQ_CLOUD_MODELS: 'mixtral-8x7b' })).toEqual(
      {
        groq_cloud: ['mixtral-8x7b'],
      },
    );
  });
});
