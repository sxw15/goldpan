import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoldpanConfig } from '../../src/config/index.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { createStubConfigStore } from '../pipeline/fixtures/index.js';

// Spy `wrapLanguageModel` / `defaultSettingsMiddleware` while keeping their
// real implementations — lets tests assert what providerOptions actually
// reach the middleware (the load-bearing contract for per-step thinking).
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    wrapLanguageModel: vi.fn(actual.wrapLanguageModel),
    defaultSettingsMiddleware: vi.fn(actual.defaultSettingsMiddleware),
  };
});

/**
 * Build a minimal `GoldpanConfig`-shaped object for registry tests. Only the
 * fields the registry reads are populated; everything else is asserted-cast.
 */
function makeConfig(overrides: {
  llm?: Partial<GoldpanConfig['llm']>;
  llmProviderOptions?: GoldpanConfig['llmProviderOptions'];
  embedding?: Partial<GoldpanConfig['embedding']>;
  relation?: Partial<GoldpanConfig['relation']>;
  providerBaseUrls?: Partial<GoldpanConfig['providerBaseUrls']>;
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
    llmProviderOptions: overrides.llmProviderOptions ?? {},
    embedding: {
      enabled: false,
      model: 'openai:text-embedding-3-small',
      dimensions: 0,
      batchSize: 100,
      ...overrides.embedding,
    },
    providerBaseUrls: {
      deepseek: 'https://api.deepseek.com',
      ollama: 'http://localhost:11434/v1',
      ...overrides.providerBaseUrls,
    },
    relation: { enabled: false, ...overrides.relation },
    customLlmProviders: [],
  } as unknown as GoldpanConfig;
}

describe('createLlmRegistry', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (
        key.startsWith('GOLDPAN_') ||
        key === 'OPENAI_API_KEY' ||
        key === 'ANTHROPIC_API_KEY' ||
        key === 'DEEPSEEK_API_KEY' ||
        key === 'GOOGLE_GENERATIVE_AI_API_KEY' ||
        key === 'DEEPSEEK_BASE_URL' ||
        key === 'OLLAMA_BASE_URL'
      ) {
        delete process.env[key];
      }
    }
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe('basic provider construction', () => {
    it('resolves a step to its configured model (openai)', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key-12345678901234567890';
      const { createLlmRegistry } = await import('../../src/llm/registry.js');

      const registry = createLlmRegistry(
        createStubConfigStore(makeConfig({ llm: { classifier: 'openai:gpt-4o-mini' } })),
        new PluginRegistry(),
      );
      const model = registry.languageModel('classifier');
      expect(model).toBeDefined();
      // ProviderRegistryProvider returns LanguageModelV3-compatible objects
      // exposing modelId/provider on the underlying object
      const m = model as unknown as { modelId: string; provider: string };
      expect(m.modelId).toBe('gpt-4o-mini');
      expect(m.provider).toContain('openai');
    });

    it('uses createDeepSeek (not openai-compatible) for deepseek', async () => {
      process.env.DEEPSEEK_API_KEY = 'sk-deepseek-test-key';
      const { createLlmRegistry } = await import('../../src/llm/registry.js');

      const registry = createLlmRegistry(
        createStubConfigStore(
          makeConfig({
            llm: {
              classifier: 'deepseek:deepseek-chat',
              extractor: 'deepseek:deepseek-chat',
              matcher: 'deepseek:deepseek-chat',
              comparator: 'deepseek:deepseek-chat',
              verifier: 'deepseek:deepseek-chat',
              intent: 'deepseek:deepseek-chat',
              query: 'deepseek:deepseek-chat',
              digestSummary: 'deepseek:deepseek-chat',
              digestAction: 'deepseek:deepseek-chat',
            },
          }),
        ),
        new PluginRegistry(),
      );
      const model = registry.languageModel('classifier');
      expect(model).toBeDefined();
      // The deepseek provider name should bubble through
      const m = model as unknown as { provider: string };
      expect(m.provider).toContain('deepseek');
    });

    it('still supports ollama via openai-compatible (no API key needed)', async () => {
      const { createLlmRegistry } = await import('../../src/llm/registry.js');
      const registry = createLlmRegistry(
        createStubConfigStore(
          makeConfig({
            llm: {
              classifier: 'ollama:qwen2.5:7b',
              extractor: 'ollama:qwen2.5:7b',
              matcher: 'ollama:qwen2.5:7b',
              comparator: 'ollama:qwen2.5:7b',
              verifier: 'ollama:qwen2.5:7b',
              intent: 'ollama:qwen2.5:7b',
              query: 'ollama:qwen2.5:7b',
              digestSummary: 'ollama:qwen2.5:7b',
              digestAction: 'ollama:qwen2.5:7b',
            },
          }),
        ),
        new PluginRegistry(),
      );
      const model = registry.languageModel('classifier');
      expect(model).toBeDefined();
    });

    it('registers multiple providers when steps reference them', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key-12345678901234567890';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-1234567890';
      const { createLlmRegistry } = await import('../../src/llm/registry.js');

      const registry = createLlmRegistry(
        createStubConfigStore(
          makeConfig({
            llm: {
              classifier: 'openai:gpt-4o-mini',
              extractor: 'anthropic:claude-sonnet-4-20250514',
            },
          }),
        ),
        new PluginRegistry(),
      );
      expect(registry.languageModel('classifier')).toBeDefined();
      expect(registry.languageModel('extractor')).toBeDefined();
    });

    it('creates google provider', async () => {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'AIza-test-key-12345678901234567890';
      const { createLlmRegistry } = await import('../../src/llm/registry.js');

      const registry = createLlmRegistry(
        createStubConfigStore(makeConfig({ llm: { classifier: 'google:gemini-2.0-flash' } })),
        new PluginRegistry(),
      );
      const model = registry.languageModel('classifier');
      expect(model).toBeDefined();
    });

    it('loads a provider referenced only by the translator step', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key-12345678901234567890';
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'AIza-test-key-12345678901234567890';
      const { createLlmRegistry } = await import('../../src/llm/registry.js');

      const registry = createLlmRegistry(
        createStubConfigStore(
          makeConfig({
            llm: { translator: 'google:gemini-2.0-flash' },
          }),
        ),
        new PluginRegistry(),
      );
      const model = registry.languageModel('translator');
      expect(model).toBeDefined();
      const m = model as unknown as { provider: string };
      expect(m.provider).toContain('google');
    });

    it('throws for unknown provider', async () => {
      const { createLlmRegistry } = await import('../../src/llm/registry.js');
      // Provider-map build is lazy (gated by configStore.generation cache);
      // the unknown-provider error surfaces on the first languageModel() call.
      const registry = createLlmRegistry(
        createStubConfigStore(
          makeConfig({
            llm: {
              classifier: 'unknown-provider:some-model',
              extractor: 'unknown-provider:some-model',
              matcher: 'unknown-provider:some-model',
              comparator: 'unknown-provider:some-model',
              verifier: 'unknown-provider:some-model',
              intent: 'unknown-provider:some-model',
              query: 'unknown-provider:some-model',
              digestSummary: 'unknown-provider:some-model',
              digestAction: 'unknown-provider:some-model',
            },
          }),
        ),
        new PluginRegistry(),
      );
      expect(() => registry.languageModel('classifier')).toThrow(/unknown.*provider/i);
    });

    it('throws when accessing a step with no configured model', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key-12345678901234567890';
      const { createLlmRegistry } = await import('../../src/llm/registry.js');
      const config = makeConfig({});
      // Force-blank the verifier model id to simulate a misconfigured step.
      // (Production code path: verifierEnabled=false leaves verifier undefined.)
      (config.llm as { verifier?: string }).verifier = undefined;
      const registry = createLlmRegistry(createStubConfigStore(config), new PluginRegistry());
      expect(() => registry.languageModel('verifier')).toThrow(/no llm model configured/i);
    });
  });

  describe('per-step provider options (wrap/no-wrap)', () => {
    it('returns baseModel unwrapped when no options configured', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key-12345678901234567890';
      const { createLlmRegistry } = await import('../../src/llm/registry.js');

      const registry = createLlmRegistry(
        createStubConfigStore(makeConfig({})),
        new PluginRegistry(),
      );
      const model = registry.languageModel('classifier');
      // Unwrapped models expose `provider` directly; wrapped ones wrap them.
      const m = model as unknown as { provider: string };
      expect(m.provider).toBeDefined();
      expect(m.provider).toContain('openai');
    });

    it('wraps model when options match the step provider', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-1234567890';
      const { createLlmRegistry } = await import('../../src/llm/registry.js');

      const baseRegistry = createLlmRegistry(
        createStubConfigStore(
          makeConfig({ llm: { extractor: 'anthropic:claude-sonnet-4-20250514' } }),
        ),
        new PluginRegistry(),
      );
      const wrappedRegistry = createLlmRegistry(
        createStubConfigStore(
          makeConfig({
            llm: { extractor: 'anthropic:claude-sonnet-4-20250514' },
            llmProviderOptions: {
              extractor: { anthropic: { thinking: { type: 'adaptive' } } },
            },
          }),
        ),
        new PluginRegistry(),
      );

      const base = baseRegistry.languageModel('extractor');
      const wrapped = wrappedRegistry.languageModel('extractor');
      // wrapLanguageModel returns a different object than the underlying model
      expect(wrapped).not.toBe(base);
      // The wrapped model still exposes provider/modelId for downstream code
      const w = wrapped as unknown as { provider: string; modelId: string };
      expect(w.provider).toContain('anthropic');
      expect(w.modelId).toBe('claude-sonnet-4-20250514');
    });

    it('does NOT wrap when options provider differs from model provider', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key-12345678901234567890';
      const { createLlmRegistry } = await import('../../src/llm/registry.js');

      // step uses openai but only anthropic options are configured → ignored
      const registry = createLlmRegistry(
        createStubConfigStore(
          makeConfig({
            llm: { extractor: 'openai:gpt-4o-mini' },
            llmProviderOptions: {
              extractor: { anthropic: { thinking: { type: 'adaptive' } } },
            },
          }),
        ),
        new PluginRegistry(),
      );
      const model = registry.languageModel('extractor');
      const m = model as unknown as { provider: string; modelId: string };
      // provider should still be openai (no wrap from anthropic options)
      expect(m.provider).toContain('openai');
      expect(m.modelId).toBe('gpt-4o-mini');
    });

    it('different steps get independent options', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key-12345678901234567890';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-1234567890';
      const { createLlmRegistry } = await import('../../src/llm/registry.js');

      const registry = createLlmRegistry(
        createStubConfigStore(
          makeConfig({
            llm: {
              classifier: 'openai:gpt-4o-mini',
              extractor: 'anthropic:claude-sonnet-4-20250514',
            },
            llmProviderOptions: {
              classifier: { openai: { reasoningEffort: 'low' } },
              extractor: { anthropic: { thinking: { type: 'adaptive' } } },
            },
          }),
        ),
        new PluginRegistry(),
      );
      const classifierModel = registry.languageModel('classifier');
      const extractorModel = registry.languageModel('extractor');
      // both should be wrapped (different objects, different providers)
      const c = classifierModel as unknown as { provider: string };
      const e = extractorModel as unknown as { provider: string };
      expect(c.provider).toContain('openai');
      expect(e.provider).toContain('anthropic');
    });

    it('wrap carries the configured providerOptions into the middleware', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-1234567890';
      const ai = await import('ai');
      const middlewareSpy = vi.mocked(ai.defaultSettingsMiddleware);
      middlewareSpy.mockClear();

      const { createLlmRegistry } = await import('../../src/llm/registry.js');
      const registry = createLlmRegistry(
        createStubConfigStore(
          makeConfig({
            llm: { extractor: 'anthropic:claude-sonnet-4-20250514' },
            llmProviderOptions: {
              extractor: { anthropic: { thinking: { type: 'adaptive' } } },
            },
          }),
        ),
        new PluginRegistry(),
      );

      registry.languageModel('extractor');

      expect(middlewareSpy).toHaveBeenCalledTimes(1);
      expect(middlewareSpy).toHaveBeenCalledWith({
        settings: {
          providerOptions: { anthropic: { thinking: { type: 'adaptive' } } },
        },
      });
    });

    it('does NOT invoke the middleware when no options apply', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key-12345678901234567890';
      const ai = await import('ai');
      const middlewareSpy = vi.mocked(ai.defaultSettingsMiddleware);
      // Clear any calls accumulated from other tests in this describe block —
      // vitest does not auto-clear vi.fn between tests by default.
      middlewareSpy.mockClear();

      const { createLlmRegistry } = await import('../../src/llm/registry.js');
      const registry = createLlmRegistry(
        createStubConfigStore(makeConfig({})),
        new PluginRegistry(),
      );
      registry.languageModel('classifier');

      expect(middlewareSpy).not.toHaveBeenCalled();
    });

    it('treats empty options object the same as missing', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key-12345678901234567890';
      const { createLlmRegistry } = await import('../../src/llm/registry.js');

      const baseRegistry = createLlmRegistry(
        createStubConfigStore(makeConfig({})),
        new PluginRegistry(),
      );
      const emptyOptsRegistry = createLlmRegistry(
        createStubConfigStore(
          makeConfig({
            llmProviderOptions: { classifier: { openai: {} } },
          }),
        ),
        new PluginRegistry(),
      );

      const base = baseRegistry.languageModel('classifier');
      const withEmpty = emptyOptsRegistry.languageModel('classifier');
      // Both unwrapped → underlying provider model objects (same structure)
      const b = base as unknown as { provider: string };
      const e = withEmpty as unknown as { provider: string };
      expect(b.provider).toBe(e.provider);
    });
  });
});
