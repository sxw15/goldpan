import type { GoldpanConfig } from '../config';
import type { CustomLlmProvider } from '../config/llm-providers';

const KEYLESS_PROVIDERS = new Set(['ollama']);

const PROVIDER_KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export interface ProviderKeyOptions {
  customProviders?: ReadonlyArray<CustomLlmProvider>;
  knownProviderIds?: ReadonlyArray<string>;
}

export function providerOf(modelId: string | undefined): string | null {
  if (!modelId) return null;
  const i = modelId.indexOf(':');
  return i > 0 ? modelId.slice(0, i) : null;
}

export function missingKeyedProviders(
  modelIds: Array<string | undefined>,
  env: NodeJS.ProcessEnv,
  options: ProviderKeyOptions = {},
): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  const customKeyEnv = new Map((options.customProviders ?? []).map((p) => [p.id, p.apiKeyEnv]));
  const knownProviderIds = new Set(options.knownProviderIds ?? []);
  for (const modelId of modelIds) {
    const provider = providerOf(modelId);
    if (!provider || KEYLESS_PROVIDERS.has(provider) || seen.has(provider)) continue;
    seen.add(provider);
    const envKey = PROVIDER_KEY_ENV[provider] ?? customKeyEnv.get(provider);
    if (!envKey && knownProviderIds.has(provider)) continue;
    if (!envKey || env[envKey] === undefined || env[envKey] === '') {
      missing.push(provider);
    }
  }
  return missing;
}

export function providerKeyEnv(provider: string, options: ProviderKeyOptions = {}): string {
  const custom = options.customProviders?.find((p) => p.id === provider);
  return PROVIDER_KEY_ENV[provider] ?? custom?.apiKeyEnv ?? `${provider.toUpperCase()}_API_KEY`;
}

export function modelIdsFromConfig(config: GoldpanConfig): string[] {
  return [
    config.llm.classifier,
    config.llm.extractor,
    config.llm.matcher,
    config.llm.comparator,
    config.llm.intent,
    config.llm.query,
    ...(config.llm.verifierEnabled && config.llm.verifier ? [config.llm.verifier] : []),
    ...(config.relation.enabled && config.llm.relator ? [config.llm.relator] : []),
    ...(config.llm.translator ? [config.llm.translator] : []),
    ...(config.digest.enabled ? [config.llm.digestSummary, config.llm.digestAction] : []),
    ...(config.embedding.enabled ? [config.embedding.model] : []),
  ];
}
