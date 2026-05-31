import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveProjectRoot } from '../config/index';
import { errorMessage } from '../errors';
import type { PluginRegistry } from './registry';
import type { CollectorPlugin, IntentPlugin, ToolPlugin } from './types';
import { INTENT_RESULT_TYPES, isLlmProviderPlugin } from './types';

interface ExternalPluginLogger {
  info(message: string, meta?: Record<string, unknown>): unknown;
  warn(message: string, meta?: Record<string, unknown>): unknown;
  error(message: string, meta?: Record<string, unknown>): unknown;
}

interface LoadExternalPluginsOptions {
  pluginsDir?: string;
  logger: ExternalPluginLogger;
  pluginRegistry: PluginRegistry;
}

function isCollectorPlugin(value: unknown): value is CollectorPlugin {
  if (!value || typeof value !== 'object') return false;
  const plugin = value as Partial<CollectorPlugin>;
  return (
    plugin.type === 'collector' &&
    typeof plugin.name === 'string' &&
    typeof plugin.version === 'string' &&
    typeof plugin.description === 'string' &&
    typeof plugin.priority === 'number' &&
    Number.isFinite(plugin.priority) &&
    typeof plugin.canHandle === 'function' &&
    typeof plugin.collect === 'function'
  );
}

function isValidIntentPlugin(value: unknown): value is IntentPlugin {
  if (!value || typeof value !== 'object') return false;
  const plugin = value as Partial<IntentPlugin>;
  return (
    plugin.type === 'intent' &&
    typeof plugin.name === 'string' &&
    typeof plugin.version === 'string' &&
    typeof plugin.description === 'string' &&
    Array.isArray(plugin.intents) &&
    plugin.intents.length > 0 &&
    plugin.intents.every((i: unknown) => {
      if (!i || typeof i !== 'object') return false;
      const decl = i as Record<string, unknown>;
      if (typeof decl.name !== 'string' || typeof decl.description !== 'string') return false;
      if (
        'priority' in decl &&
        (typeof decl.priority !== 'number' || !Number.isFinite(decl.priority))
      )
        return false;
      if (
        'maxInputLength' in decl &&
        (typeof decl.maxInputLength !== 'number' ||
          !Number.isFinite(decl.maxInputLength) ||
          decl.maxInputLength < 0)
      )
        return false;
      if (
        'resultTypes' in decl &&
        (!Array.isArray(decl.resultTypes) ||
          !decl.resultTypes.every(
            (t: unknown) =>
              typeof t === 'string' && (INTENT_RESULT_TYPES as readonly string[]).includes(t),
          ))
      )
        return false;
      if (
        'examples' in decl &&
        (!Array.isArray(decl.examples) ||
          !decl.examples.every((e: unknown) => typeof e === 'string'))
      )
        return false;
      if (
        'classificationHints' in decl &&
        (!Array.isArray(decl.classificationHints) ||
          !decl.classificationHints.every((h: unknown) => typeof h === 'string'))
      )
        return false;
      return true;
    }) &&
    typeof plugin.execute === 'function'
  );
}

function hasZodLikeParse(schema: unknown): boolean {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    'parse' in schema &&
    typeof (schema as { parse?: unknown }).parse === 'function'
  );
}

function isValidToolPlugin(value: unknown): value is ToolPlugin {
  if (!value || typeof value !== 'object') return false;
  const plugin = value as Partial<ToolPlugin>;
  return (
    plugin.type === 'tool' &&
    typeof plugin.name === 'string' &&
    typeof plugin.version === 'string' &&
    typeof plugin.description === 'string' &&
    typeof plugin.priority === 'number' &&
    Number.isFinite(plugin.priority) &&
    Array.isArray(plugin.tools) &&
    plugin.tools.every((t: unknown) => {
      if (!t || typeof t !== 'object') return false;
      const decl = t as Record<string, unknown>;
      return (
        typeof decl.name === 'string' &&
        typeof decl.description === 'string' &&
        hasZodLikeParse(decl.inputSchema) &&
        hasZodLikeParse(decl.outputSchema)
      );
    }) &&
    typeof plugin.executeTool === 'function'
  );
}

export async function loadExternalPlugins({
  pluginsDir = path.join(resolveProjectRoot(), 'plugins'),
  logger,
  pluginRegistry,
}: LoadExternalPluginsOptions): Promise<void> {
  if (!existsSync(pluginsDir)) {
    logger.info('external plugin directory not found, skipping', { pluginsDir });
    return;
  }

  const pluginFolders = readdirSync(pluginsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && !entry.name.startsWith('im-') && !entry.name.startsWith('web-'),
    )
    .map((entry) => path.join(pluginsDir, entry.name))
    .sort((a, b) => a.localeCompare(b));

  const loadedPluginNames: string[] = [];
  // Aggregated so a clean checkout sees ALL missing builds at once (not just
  // the first), with a single actionable hint at the end.
  const missingEntries: string[] = [];
  // Import failures = dist file exists but is corrupted (broken build artefact).
  // More serious than "missing entry" — symmetric handling: aggregate in dev/test
  // for a one-shot error report; warn-only in prod so a single bad build doesn't
  // bring down the whole deploy.
  const failedImports: { entryPath: string; error: string }[] = [];
  // Tracks plugins that were warned-only in prod (missing-entry or import-fail)
  // so the summary log can give ops a single skippedCount to alert on.
  let prodSkippedCount = 0;

  for (const pluginFolder of pluginFolders) {
    const packageJsonPath = path.join(pluginFolder, 'package.json');
    if (!existsSync(packageJsonPath)) {
      logger.warn('skipping plugin folder without package.json', { pluginFolder });
      continue;
    }

    const entryPath = path.join(pluginFolder, 'dist', 'index.js');
    if (!existsSync(entryPath)) {
      // Plugin folder + package.json present but dist/index.js missing = build incomplete, not "user disabled".
      // Loud in dev/test (catches partial builds that would otherwise silently miss services); warn-only in prod.
      if (process.env.NODE_ENV !== 'production') {
        missingEntries.push(entryPath);
        continue;
      }
      logger.warn('skipping plugin without built entry (dist/index.js)', {
        pluginFolder,
        entryPath,
      });
      prodSkippedCount += 1;
      continue;
    }

    const moduleUrl =
      process.env.NODE_ENV === 'production'
        ? pathToFileURL(entryPath).href
        : `${pathToFileURL(entryPath).href}?ts=${Date.now()}`;
    let mod: { goldpanPlugin?: unknown };
    try {
      mod = (await import(/* webpackIgnore: true */ moduleUrl)) as {
        goldpanPlugin?: unknown;
      };
    } catch (err) {
      const message = errorMessage(err);
      logger.warn('failed to import external plugin module', {
        pluginFolder,
        err: message,
        stack: err instanceof Error ? err.stack : undefined,
      });
      if (process.env.NODE_ENV !== 'production') {
        failedImports.push({ entryPath, error: message });
      } else {
        prodSkippedCount += 1;
      }
      continue;
    }

    if (!('goldpanPlugin' in mod)) {
      logger.warn('skipping plugin that does not export "goldpanPlugin"', { pluginFolder });
      continue;
    }

    if (
      !isCollectorPlugin(mod.goldpanPlugin) &&
      !isValidIntentPlugin(mod.goldpanPlugin) &&
      !isValidToolPlugin(mod.goldpanPlugin) &&
      !isLlmProviderPlugin(mod.goldpanPlugin)
    ) {
      logger.warn('skipping plugin with unsupported type', { pluginFolder });
      continue;
    }

    try {
      pluginRegistry.register(mod.goldpanPlugin, {
        settingsAssetDir: path.join(pluginFolder, 'static'),
      });
    } catch (err) {
      logger.warn('failed to register external plugin', {
        pluginFolder,
        pluginName: mod.goldpanPlugin.name,
        err: errorMessage(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      continue;
    }

    loadedPluginNames.push(mod.goldpanPlugin.name);
    logger.info('registered external plugin', {
      pluginFolder,
      pluginName: mod.goldpanPlugin.name,
    });
  }

  // Throw BEFORE the summary log so users don't see "loaded 0" then a stack —
  // the summary should describe the actual outcome, not a half-finished load.
  if (missingEntries.length + failedImports.length > 0) {
    const sections: string[] = [];
    if (missingEntries.length > 0) {
      const list = missingEntries.map((p) => `  - ${p}`).join('\n');
      sections.push(
        `Plugin entry missing — ${missingEntries.length} plugin(s) lack a built dist/index.js:\n${list}`,
      );
    }
    if (failedImports.length > 0) {
      const list = failedImports.map((f) => `  - ${f.entryPath}\n      ${f.error}`).join('\n');
      sections.push(
        `Plugin import failed — ${failedImports.length} plugin(s) had a corrupted build artefact:\n${list}`,
      );
    }
    throw new Error(
      `External plugins failed to load:\n\n${sections.join('\n\n')}\n\nRun \`pnpm dev:prebuild\` (root) or \`pnpm -r build\` to rebuild all plugins.`,
    );
  }

  logger.info('external plugins load summary', {
    pluginsDir,
    loadedCount: loadedPluginNames.length,
    skippedCount: prodSkippedCount,
    loadedPlugins: loadedPluginNames,
  });
}
