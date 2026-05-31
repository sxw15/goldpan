import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveProjectRoot } from '../config/index';
import { isLlmProviderPlugin } from './types';

export interface LlmProviderPluginInfo {
  name: string;
  providerId: string;
}

/**
 * Lightweight scan of `plugins/*` for LlmProviderPlugin entries — used by the
 * onboarding wizard, which runs before `bootstrap()` and so has no
 * PluginRegistry. Mirrors loadExternalPlugins' folder-filter rules (skip
 * `im-*` / `web-*`, require `dist/index.js`) but does NOT instantiate
 * `createProvider()` — only reads the static metadata. Failures are silent;
 * the wizard treats unknown plugins as "not available" rather than blocking
 * onboarding on a broken plugin build.
 */
export async function scanLlmProviderPlugins(
  pluginsDir = path.join(resolveProjectRoot(), 'plugins'),
): Promise<LlmProviderPluginInfo[]> {
  if (!existsSync(pluginsDir)) return [];

  const folders = readdirSync(pluginsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && !entry.name.startsWith('im-') && !entry.name.startsWith('web-'),
    )
    .map((entry) => path.join(pluginsDir, entry.name))
    .sort((a, b) => a.localeCompare(b));

  const results: LlmProviderPluginInfo[] = [];
  for (const folder of folders) {
    const entry = path.join(folder, 'dist', 'index.js');
    if (!existsSync(entry)) continue;

    let mod: { goldpanPlugin?: unknown };
    try {
      mod = (await import(pathToFileURL(entry).href)) as { goldpanPlugin?: unknown };
    } catch {
      continue;
    }

    if (isLlmProviderPlugin(mod.goldpanPlugin)) {
      results.push({ name: mod.goldpanPlugin.name, providerId: mod.goldpanPlugin.providerId });
    }
  }
  return results;
}
