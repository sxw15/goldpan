import type { GoldpanConfig } from '@goldpan/core/config';
import type { LlmProviderPlugin, PluginRegistry } from '@goldpan/core/plugins';
import { type RouteContext, respond, respondError } from './types.js';

interface BuiltinProviderInfo {
  id: string;
  apiKeyEnv: string;
  apiKeyConfigured: boolean;
  /** chat models (Pipeline / Digest 下拉用)。来源 `GOLDPAN_LLM_PROVIDER_<ID>_MODELS`。 */
  models: string[];
  /** embedding models (Embedding 设置 / onboarding 下拉用)。来源 `_EMBEDDING_MODELS`。 */
  embeddingModels: string[];
}
interface CustomProviderInfo {
  id: string;
  baseUrl: string;
  apiKeyEnv: string;
  apiKeyConfigured: boolean;
  models: string[];
  embeddingModels: string[];
}
interface PluginProviderInfo {
  providerId: string;
  pluginName: string;
  status: 'loaded' | 'failed' | 'skipped_conflict';
  error?: string;
  models: string[];
  embeddingModels: string[];
}
export interface LlmProvidersSnapshot {
  builtin: BuiltinProviderInfo[];
  custom: CustomProviderInfo[];
  plugin: PluginProviderInfo[];
}

const BUILTIN_KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  ollama: '',
  openrouter: 'OPENROUTER_API_KEY',
};

export function buildLlmProvidersSnapshot(
  config: GoldpanConfig,
  pluginRegistry: PluginRegistry,
): LlmProvidersSnapshot {
  const builtin: BuiltinProviderInfo[] = Object.entries(BUILTIN_KEY_ENV).map(([id, apiKeyEnv]) => ({
    id,
    apiKeyEnv,
    // Ollama: 本地推理无 API key，由 GOLDPAN_OLLAMA_ENABLED 显式开关控制 UI 可用性。
    // 默认 false → 不在 Pipeline 下拉里出现，避免没装本地 daemon 的用户看到失败选项。
    // 其它 builtin: 沿用 "env 里有 key 就算 configured" 的旧逻辑。
    apiKeyConfigured: apiKeyEnv === '' ? config.ollamaEnabled : !!process.env[apiKeyEnv],
    // Models 全部走 `providerModels[id]` —— 用户在 Provider 页编辑写入
    // `GOLDPAN_LLM_PROVIDER_<ID>_MODELS` env，前端 Pipeline 下拉直接读这个统一来源，
    // 不再有 server / 前端各自的默认表（后端不维护一份动态变化的官方 model 名录，
    // 前端不再硬编码 fallback）。空数组时前端走「自定义输入」退路。
    models: config.providerModels[id] ?? [],
    embeddingModels: config.providerEmbeddingModels[id] ?? [],
  }));

  const custom: CustomProviderInfo[] = config.customLlmProviders.map((p) => ({
    id: p.id,
    baseUrl: p.baseUrl,
    apiKeyEnv: p.apiKeyEnv,
    apiKeyConfigured: !!process.env[p.apiKeyEnv],
    models: config.providerModels[p.id] ?? p.models,
    embeddingModels: config.providerEmbeddingModels[p.id] ?? [],
  }));

  const status = pluginRegistry.getLlmProviderLoadStatus();
  const plugin: PluginProviderInfo[] = pluginRegistry
    .getLlmProviderPlugins()
    .map((p: LlmProviderPlugin) => {
      const recorded = status[p.name];
      if (recorded) {
        return {
          providerId: p.providerId,
          pluginName: p.name,
          status: recorded.status,
          ...(recorded.error ? { error: recorded.error } : {}),
          models: config.providerModels[p.providerId] ?? [],
          embeddingModels: config.providerEmbeddingModels[p.providerId] ?? [],
        };
      }
      // Unrecorded → not yet exercised (lazy). Treat as loaded for UI display;
      // first usage will record real status.
      return {
        providerId: p.providerId,
        pluginName: p.name,
        status: 'loaded' as const,
        models: config.providerModels[p.providerId] ?? [],
        embeddingModels: config.providerEmbeddingModels[p.providerId] ?? [],
      };
    });

  return { builtin, custom, plugin };
}

export interface LlmProvidersRouteDeps {
  pluginRegistry: PluginRegistry;
  /**
   * Pulls the latest `GoldpanConfig` per request — wraps
   * `configStore.getSnapshot().config` in normal mode. Custom LLM providers
   * declared via `GOLDPAN_LLM_PROVIDER_<ID>_BASE_URL` / `_API_KEY_ENV` are
   * persisted through `configStore.commit`, so reading the boot snapshot
   * (legacy shape) would hide newly-added providers until the server
   * restarts. Mirrors `ImSettingsRoutesDeps.getConfig`.
   */
  getConfig: () => GoldpanConfig;
}

export function createLlmProvidersRoute(deps: LlmProvidersRouteDeps) {
  return async function handle(ctx: RouteContext): Promise<void> {
    const { req, res } = ctx;
    if (req.method !== 'GET') {
      req.resume();
      respondError(res, 405, 'method_not_allowed', 'Method not allowed');
      return;
    }
    req.resume();
    respond(res, 200, buildLlmProvidersSnapshot(deps.getConfig(), deps.pluginRegistry));
  };
}
