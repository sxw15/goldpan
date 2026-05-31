import type { GoldpanConfig } from '@goldpan/core/config';
import type { Language } from '@goldpan/core/i18n';
import {
  type PluginRegistry,
  type PluginSettingsContribution,
  resolvePluginDescription,
} from '@goldpan/core/plugins';
import { PLUGIN_CONFIG_GROUP_MAP, type PluginConfigGroupId } from './plugin-config-group-map.js';
import { type RouteContext, respond, respondError } from './types.js';

const BUILTIN_NAMES: ReadonlySet<string> = new Set([
  'intent-submit',
  'intent-query',
  'collector-web',
]);

export type PluginType = 'collector' | 'intent' | 'tool' | 'llm-provider';

export interface PluginInfo {
  name: string;
  displayName: string;
  version: string;
  description: string;
  type: PluginType;
  status: 'loaded' | 'failed' | 'skipped_conflict';
  error?: string;
  envKeys: { key: string; configured: boolean }[];
  configGroup?: PluginConfigGroupId;
}

export interface PluginsSnapshot {
  plugins: PluginInfo[];
  registryInstallSupported: false;
}

type PluginMeta = {
  name: string;
  version: string;
  description: string;
  descriptions?: Partial<Record<Language, string>>;
  settingsContribution?: PluginSettingsContribution;
};

interface PluginRegistryRead {
  getCollectors(): readonly PluginMeta[];
  getIntentPlugins(): readonly PluginMeta[];
  getToolPlugins(): readonly PluginMeta[];
  getLlmProviderPlugins(): readonly PluginMeta[];
  getLlmProviderLoadStatus(): Record<
    string,
    { status: 'loaded' | 'failed' | 'skipped_conflict'; error?: string }
  >;
}

function parseLocale(value: string | null, fallback: Language): Language {
  if (value === 'en' || value === 'zh') return value;
  return fallback;
}

function displayName(pkgName: string): string {
  // "@goldpan/plugin-foo-bar" → "foo-bar"
  // "tracking" → "tracking"
  const slash = pkgName.lastIndexOf('/');
  const base = slash >= 0 ? pkgName.slice(slash + 1) : pkgName;
  return base.startsWith('plugin-') ? base.slice('plugin-'.length) : base;
}

function buildEnvKeys(pkg: PluginMeta): { key: string; configured: boolean }[] {
  const contribution = pkg.settingsContribution;
  if (contribution === undefined) return [];
  const keys: string[] = [];
  if (contribution.enable !== undefined) {
    keys.push(contribution.enable.envKey);
  }
  for (const field of contribution.fields) {
    keys.push(field.envKey);
  }
  return keys.map((key) => ({
    key,
    configured: Boolean(process.env[key]?.trim()),
  }));
}

function buildPluginInfo(
  pkg: PluginMeta,
  type: PluginType,
  locale: Language,
  llmStatus?: { status: 'loaded' | 'failed' | 'skipped_conflict'; error?: string },
): PluginInfo {
  const envKeys = buildEnvKeys(pkg);
  const configGroup = PLUGIN_CONFIG_GROUP_MAP[pkg.name];
  return {
    name: pkg.name,
    displayName: displayName(pkg.name),
    version: pkg.version,
    description: resolvePluginDescription(pkg, locale),
    type,
    status: llmStatus?.status ?? 'loaded',
    ...(llmStatus?.error ? { error: llmStatus.error } : {}),
    envKeys,
    ...(configGroup ? { configGroup } : {}),
  };
}

export function buildPluginsSnapshot(
  reg: PluginRegistryRead,
  locale: Language = 'en',
): PluginsSnapshot {
  const plugins: PluginInfo[] = [];

  for (const c of reg.getCollectors()) {
    if (BUILTIN_NAMES.has(c.name)) continue;
    plugins.push(buildPluginInfo(c, 'collector', locale));
  }
  for (const i of reg.getIntentPlugins()) {
    if (BUILTIN_NAMES.has(i.name)) continue;
    plugins.push(buildPluginInfo(i, 'intent', locale));
  }
  for (const t of reg.getToolPlugins()) {
    if (BUILTIN_NAMES.has(t.name)) continue;
    plugins.push(buildPluginInfo(t, 'tool', locale));
  }
  const llmStatus = reg.getLlmProviderLoadStatus();
  for (const l of reg.getLlmProviderPlugins()) {
    if (BUILTIN_NAMES.has(l.name)) continue;
    plugins.push(buildPluginInfo(l, 'llm-provider', locale, llmStatus[l.name]));
  }

  // Sort within each type by name asc — type ordering preserved by insertion above.
  plugins.sort((a, b) => {
    if (a.type !== b.type) return 0;
    return a.name.localeCompare(b.name);
  });

  return { plugins, registryInstallSupported: false };
}

export interface PluginsRouteDeps {
  pluginRegistry: PluginRegistry;
  /**
   * Pulled per-request so a /settings/env commit's language change takes effect
   * on the next call without a server restart. Mirrors contributions.ts.
   */
  getConfig: () => GoldpanConfig;
}

export function createPluginsRoute(deps: PluginsRouteDeps) {
  return async function handle(ctx: RouteContext): Promise<void> {
    const { req, res, url } = ctx;
    if (req.method !== 'GET') {
      req.resume();
      respondError(res, 405, 'method_not_allowed', 'Method not allowed');
      return;
    }
    req.resume();
    const config = deps.getConfig();
    const locale = parseLocale(url.searchParams.get('locale'), config.language);
    respond(
      res,
      200,
      buildPluginsSnapshot(deps.pluginRegistry as unknown as PluginRegistryRead, locale),
    );
  };
}
