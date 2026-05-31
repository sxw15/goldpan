import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

describe('loadConfig: customLlmProviders', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GOLDPAN_') || key === 'TOGETHER_API_KEY') {
        delete process.env[key];
      }
    }
    process.env.NODE_ENV = 'test';
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

  it('defaults to empty customLlmProviders', () => {
    const cfg = loadConfig();
    expect(cfg.customLlmProviders).toEqual([]);
  });

  it('populates customLlmProviders from env', () => {
    process.env.GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL = 'https://api.together.xyz/v1';
    process.env.GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV = 'TOGETHER_API_KEY';
    process.env.TOGETHER_API_KEY = 'tgp_xxx';
    const cfg = loadConfig();
    expect(cfg.customLlmProviders).toEqual([
      {
        id: 'together',
        baseUrl: 'https://api.together.xyz/v1',
        apiKeyEnv: 'TOGETHER_API_KEY',
        models: [],
      },
    ]);
  });

  it('threads `_MODELS` env into customLlmProviders[].models', () => {
    process.env.GOLDPAN_LLM_PROVIDER_TOGETHER_BASE_URL = 'https://api.together.xyz/v1';
    process.env.GOLDPAN_LLM_PROVIDER_TOGETHER_API_KEY_ENV = 'TOGETHER_API_KEY';
    process.env.GOLDPAN_LLM_PROVIDER_TOGETHER_MODELS = 'llama-3.3-70b-instruct,mixtral-8x7b';
    process.env.TOGETHER_API_KEY = 'tgp_xxx';
    const cfg = loadConfig();
    expect(cfg.customLlmProviders[0]?.models).toEqual(['llama-3.3-70b-instruct', 'mixtral-8x7b']);
  });

  it('parses GOLDPAN_LLM_PROVIDER_OLLAMA_MODELS into providerModels.ollama', () => {
    process.env.GOLDPAN_OLLAMA_ENABLED = 'true';
    process.env.GOLDPAN_LLM_PROVIDER_OLLAMA_MODELS = 'llama3.2:8b, qwen2.5:7b';
    const cfg = loadConfig();
    expect(cfg.ollamaEnabled).toBe(true);
    expect(cfg.providerModels.ollama).toEqual(['llama3.2:8b', 'qwen2.5:7b']);
  });

  it('parses _MODELS for builtin provider ids without requiring _BASE_URL', () => {
    process.env.GOLDPAN_LLM_PROVIDER_ANTHROPIC_MODELS =
      'claude-sonnet-4-5-20250929, claude-haiku-4-5-20251001';
    process.env.GOLDPAN_LLM_PROVIDER_OPENAI_MODELS = 'gpt-4o, gpt-4o-mini';
    const cfg = loadConfig();
    // No _BASE_URL means these should NOT show up in customLlmProviders
    expect(cfg.customLlmProviders).toEqual([]);
    // But should populate providerModels
    expect(cfg.providerModels.anthropic).toEqual([
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
    ]);
    expect(cfg.providerModels.openai).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('defaults ollamaEnabled to false and providerModels to {}', () => {
    const cfg = loadConfig();
    expect(cfg.ollamaEnabled).toBe(false);
    expect(cfg.providerModels).toEqual({});
  });

  it('startup-throws when an entry is malformed (id collision with builtin)', () => {
    process.env.GOLDPAN_LLM_PROVIDER_OPENAI_BASE_URL = 'https://example.com/v1';
    process.env.GOLDPAN_LLM_PROVIDER_OPENAI_API_KEY_ENV = 'EXAMPLE_KEY';
    process.env.EXAMPLE_KEY = 'x';
    expect(() => loadConfig()).toThrow(/openai.*reserved.*builtin/i);
  });
});
