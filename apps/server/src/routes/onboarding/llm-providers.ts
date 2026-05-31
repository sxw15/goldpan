// apps/server/src/routes/onboarding/llm-providers.ts
import type http from 'node:http';
import {
  type CustomLlmProvider,
  parseCustomLlmProviders,
  parseProviderModels,
} from '@goldpan/core/config';
import { type LlmProviderPluginInfo, scanLlmProviderPlugins } from '@goldpan/core/plugins';
import { respond } from '../types.js';

interface BuiltinInfo {
  id: string;
  apiKeyEnv: string;
  apiKeyConfigured: boolean;
  models: string[];
}
interface CustomInfo {
  id: string;
  baseUrl: string;
  apiKeyEnv: string;
  apiKeyConfigured: boolean;
  models: string[];
}
interface PluginInfo {
  providerId: string;
  pluginName: string;
  status: 'loaded';
  models: string[];
}

export interface OnboardingLlmProvidersSnapshot {
  builtin: BuiltinInfo[];
  custom: CustomInfo[];
  plugin: PluginInfo[];
}

const BUILTIN_KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  ollama: '',
  openrouter: 'OPENROUTER_API_KEY',
};

interface BuildOptions {
  /** Override the plugin scanner — used in tests. */
  scanPlugins?: () => Promise<LlmProviderPluginInfo[]>;
}

/**
 * Pre-bootstrap snapshot of available LLM providers, used by the onboarding
 * wizard to populate its model picker. Mirrors `/settings/llm-providers` in
 * shape so the same web-side types apply, but plugin entries always come back
 * with `status: 'loaded'` — the scanner only reads metadata, doesn't probe
 * `createProvider()`. The real load status surfaces post-bootstrap via the
 * settings page.
 */
export async function buildOnboardingLlmProvidersSnapshot(
  opts: BuildOptions = {},
): Promise<OnboardingLlmProvidersSnapshot> {
  const providerModels = parseProviderModels(process.env);
  const builtin: BuiltinInfo[] = Object.entries(BUILTIN_KEY_ENV).map(([id, apiKeyEnv]) => ({
    id,
    apiKeyEnv,
    apiKeyConfigured: apiKeyEnv === '' ? true : !!process.env[apiKeyEnv],
    models: providerModels[id] ?? [],
  }));

  // parseCustomLlmProviders throws if a custom provider declares an apiKeyEnv
  // pointing at an unset env var. During wizard the user might have a half-
  // configured .env (set BASE_URL / API_KEY_ENV but no key value yet); rather
  // than crashing the wizard's provider list, swallow and return [].
  // Explicit `parsed: CustomLlmProvider[]` and `c: CustomLlmProvider` annotations
  // — the dist .d.ts types `parseCustomLlmProviders` via Zod's `z.infer`, which
  // doesn't propagate cleanly through the .map callback (TS7006).
  let custom: CustomInfo[];
  try {
    const parsed: CustomLlmProvider[] = parseCustomLlmProviders(process.env);
    custom = parsed.map((c: CustomLlmProvider) => ({
      id: c.id,
      baseUrl: c.baseUrl,
      apiKeyEnv: c.apiKeyEnv,
      apiKeyConfigured: !!process.env[c.apiKeyEnv],
      models: providerModels[c.id] ?? c.models,
    }));
  } catch {
    custom = [];
  }

  const scan = opts.scanPlugins ?? scanLlmProviderPlugins;
  let plugin: PluginInfo[];
  try {
    // Explicit `scanned: LlmProviderPluginInfo[]` — `scanLlmProviderPlugins`
    // declares `pluginsDir?: any` in its dist .d.ts (unbuild collapses the
    // string default), which pollutes inference of the awaited result.
    const scanned: LlmProviderPluginInfo[] = await scan();
    plugin = scanned.map((p: LlmProviderPluginInfo) => ({
      providerId: p.providerId,
      pluginName: p.name,
      status: 'loaded' as const,
      models: providerModels[p.providerId] ?? [],
    }));
  } catch {
    plugin = [];
  }

  return { builtin, custom, plugin };
}

export async function handleOnboardingLlmProvidersRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  req.resume();
  const snap = await buildOnboardingLlmProvidersSnapshot();
  respond(res, 200, snap);
}
