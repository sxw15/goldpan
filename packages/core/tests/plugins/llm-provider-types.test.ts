import { describe, expect, it } from 'vitest';
import { isLlmProviderPlugin, type LlmProviderPlugin } from '../../src/plugins/types.js';

describe('isLlmProviderPlugin', () => {
  function makePlugin(overrides?: Partial<LlmProviderPlugin>): unknown {
    return {
      name: 'llm-cohere',
      version: '0.1.0',
      type: 'llm-provider',
      description: 'Cohere LLM provider',
      providerId: 'cohere',
      createProvider: () => ({ languageModel: () => ({}) as never }),
      ...overrides,
    };
  }

  it('accepts a fully-formed LlmProviderPlugin', () => {
    expect(isLlmProviderPlugin(makePlugin())).toBe(true);
  });

  it('rejects when type is not "llm-provider"', () => {
    expect(isLlmProviderPlugin(makePlugin({ type: 'tool' as never }))).toBe(false);
  });

  it('rejects when providerId is missing', () => {
    const p = makePlugin();
    delete (p as Record<string, unknown>).providerId;
    expect(isLlmProviderPlugin(p)).toBe(false);
  });

  it('rejects when providerId has invalid characters', () => {
    expect(isLlmProviderPlugin(makePlugin({ providerId: 'Cohere' }))).toBe(false);
    expect(isLlmProviderPlugin(makePlugin({ providerId: '1cohere' }))).toBe(false);
    expect(isLlmProviderPlugin(makePlugin({ providerId: 'cohere/v2' }))).toBe(false);
  });

  it('rejects when createProvider is not a function', () => {
    expect(isLlmProviderPlugin(makePlugin({ createProvider: undefined as never }))).toBe(false);
  });

  it('rejects null / undefined / non-object', () => {
    expect(isLlmProviderPlugin(null)).toBe(false);
    expect(isLlmProviderPlugin(undefined)).toBe(false);
    expect(isLlmProviderPlugin('string')).toBe(false);
  });
});
