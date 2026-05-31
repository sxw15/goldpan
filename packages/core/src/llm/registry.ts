import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  createProviderRegistry,
  defaultSettingsMiddleware,
  type EmbeddingModel,
  type JSONValue,
  type LanguageModel,
  wrapLanguageModel,
} from 'ai';
import type { GoldpanConfig, ProviderWithOptions, StepWithOptions } from '../config/index';
import { PROVIDERS_WITH_OPTIONS } from '../config/index';
import { BUILTIN_PROVIDER_IDS, type CustomLlmProvider } from '../config/llm-providers';
import type { ConfigStore } from '../config/store-types';
import type { PluginRegistry } from '../plugins/registry';

type ProviderInstance = ReturnType<
  | typeof createOpenAI
  | typeof createAnthropic
  | typeof createGoogleGenerativeAI
  | typeof createDeepSeek
  | typeof createOpenAICompatible
>;

// Keys MUST match `BUILTIN_PROVIDER_IDS` in config/llm-providers — kept inline
// here for factory-side dispatch so each builtin can pick its own SDK adapter.
const BUILTIN_PROVIDER_FACTORIES: Record<
  string,
  (config: GoldpanConfig) => () => ProviderInstance
> = {
  openai: (config) => () =>
    createOpenAI({
      ...(config.providerBaseUrls.openai ? { baseURL: config.providerBaseUrls.openai } : {}),
    }),
  anthropic: () => () => createAnthropic(),
  google: () => () => createGoogleGenerativeAI(),
  deepseek: (config) => () => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY environment variable is not set');
    }
    // Only forward baseURL when user explicitly sets DEEPSEEK_BASE_URL —
    // otherwise let @ai-sdk/deepseek use its built-in default.
    return createDeepSeek({
      apiKey,
      ...(config.providerBaseUrls.deepseek ? { baseURL: config.providerBaseUrls.deepseek } : {}),
    });
  },
  ollama: (config) => () =>
    createOpenAICompatible({
      name: 'ollama',
      apiKey: 'ollama',
      baseURL: config.providerBaseUrls.ollama,
    }),
  openrouter: (config) => () => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY environment variable is not set');
    }
    return createOpenAICompatible({
      name: 'openrouter',
      apiKey,
      baseURL: config.providerBaseUrls.openrouter ?? 'https://openrouter.ai/api/v1',
    });
  },
};

const PROVIDER_OPTIONS_SET = new Set<string>(PROVIDERS_WITH_OPTIONS);

function buildCustomProviderFactory(custom: CustomLlmProvider): () => ProviderInstance {
  return () => {
    // Existence already validated by parseCustomLlmProviders at load time;
    // re-check defensively in case the registry is constructed bypassing it.
    const apiKey = process.env[custom.apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `Custom LLM provider "${custom.id}" requires env var "${custom.apiKeyEnv}" but it is not set`,
      );
    }
    return createOpenAICompatible({
      name: custom.id,
      apiKey,
      baseURL: custom.baseUrl,
    });
  };
}

function collectReferencedProviders(config: GoldpanConfig): Set<string> {
  const modelIds = [
    config.llm.classifier,
    config.llm.extractor,
    config.llm.matcher,
    config.llm.comparator,
    config.llm.intent,
    config.llm.query,
    ...(config.llm.verifierEnabled && config.llm.verifier ? [config.llm.verifier] : []),
    ...(config.relation?.enabled && config.llm.relator ? [config.llm.relator] : []),
    ...(config.llm.translator ? [config.llm.translator] : []),
    config.llm.digestSummary,
    config.llm.digestAction,
  ].filter((id): id is string => typeof id === 'string');

  const referenced = new Set<string>();
  for (const modelId of modelIds) {
    referenced.add(modelId.slice(0, modelId.indexOf(':')));
  }
  if (config.embedding?.enabled) {
    referenced.add(config.embedding.model.slice(0, config.embedding.model.indexOf(':')));
  }
  return referenced;
}

function buildProviderMap(
  config: GoldpanConfig,
  pluginRegistry: PluginRegistry,
): Record<string, ProviderInstance> {
  const referenced = collectReferencedProviders(config);
  const map: Record<string, ProviderInstance> = {};

  // 1. builtin
  for (const [id, factoryBuilder] of Object.entries(BUILTIN_PROVIDER_FACTORIES)) {
    if (referenced.has(id)) {
      map[id] = factoryBuilder(config)();
    }
  }

  // 2. custom OpenAI-compatible (loadConfig already enforced no-builtin-collision)
  for (const custom of config.customLlmProviders) {
    if (!referenced.has(custom.id)) continue;
    map[custom.id] = buildCustomProviderFactory(custom)();
  }

  // 3. plugin
  for (const plugin of pluginRegistry.getLlmProviderPlugins()) {
    if (map[plugin.providerId]) {
      pluginRegistry.recordLlmProviderStatus(plugin.name, {
        status: 'skipped_conflict',
      });
      continue;
    }
    if (!referenced.has(plugin.providerId)) {
      // Lazy: skip uninvoked plugins; status unset (treated as "not yet attempted").
      continue;
    }
    try {
      map[plugin.providerId] = plugin.createProvider() as ProviderInstance;
      pluginRegistry.recordLlmProviderStatus(plugin.name, { status: 'loaded' });
    } catch (err) {
      pluginRegistry.recordLlmProviderStatus(plugin.name, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Final sweep: any referenced id not in map → unknown provider.
  // Surface the set the *user could have declared* (builtin + custom) rather than
  // the constructed map — when a single typo means `map` is empty, "(none)" is
  // worse than useless. Also append failed-plugin status so users can see e.g.
  // "you tried cohere:X but llm-cohere failed: COHERE_API_KEY missing".
  for (const id of referenced) {
    if (!map[id]) {
      const declared = [
        ...BUILTIN_PROVIDER_IDS,
        ...config.customLlmProviders.map((c) => c.id),
      ].sort();
      const failedPlugins = Object.entries(pluginRegistry.getLlmProviderLoadStatus())
        .filter(([, s]) => s.status === 'failed')
        .map(([name, s]) => `${name} failed: ${s.error}`);
      const hint =
        failedPlugins.length > 0 ? `\nPlugin load failures: ${failedPlugins.join('; ')}` : '';
      throw new Error(
        `Unknown LLM provider "${id}". Supported providers: ${declared.join(', ') || '(none)'}${hint}`,
      );
    }
  }

  return map;
}

export interface LlmRegistry {
  languageModel(step: StepWithOptions): LanguageModel;
  embeddingModel(modelId: `${string}:${string}`): EmbeddingModel;
}

export function createLlmRegistry(
  configStore: ConfigStore,
  pluginRegistry: PluginRegistry,
): LlmRegistry {
  type Cached = {
    generation: number;
    config: GoldpanConfig;
    providerRegistry: ReturnType<typeof createProviderRegistry>;
  };
  let cached: Cached | null = null;

  function ensure(): Cached {
    const snap = configStore.getSnapshot();
    if (cached && cached.generation === snap.generation) return cached;
    const providers = buildProviderMap(snap.config, pluginRegistry);
    const providerRegistry = createProviderRegistry(providers);
    cached = { generation: snap.generation, config: snap.config, providerRegistry };
    return cached;
  }

  return {
    languageModel(step) {
      const { config, providerRegistry } = ensure();
      const modelId = config.llm[step];
      if (typeof modelId !== 'string' || modelId.length === 0) {
        throw new Error(`No LLM model configured for step "${step}"`);
      }
      const baseModel = providerRegistry.languageModel(modelId as `${string}:${string}`);

      const modelProvider = modelId.slice(0, modelId.indexOf(':'));
      if (!PROVIDER_OPTIONS_SET.has(modelProvider)) return baseModel;

      const stepOptions = config.llmProviderOptions[step]?.[modelProvider as ProviderWithOptions];
      if (!stepOptions || Object.keys(stepOptions).length === 0) return baseModel;

      // JSON.parse'd content is JSON-valid by construction; cast to satisfy
      // the SDK's narrow `JSONValue` typing without runtime overhead.
      return wrapLanguageModel({
        model: baseModel,
        middleware: defaultSettingsMiddleware({
          settings: {
            providerOptions: { [modelProvider]: stepOptions as Record<string, JSONValue> },
          },
        }),
      });
    },
    embeddingModel(modelId) {
      const { providerRegistry } = ensure();
      return providerRegistry.embeddingModel(modelId);
    },
  };
}
