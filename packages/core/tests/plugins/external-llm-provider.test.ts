import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ILogObj, Logger } from 'tslog';
import { afterEach, describe, expect, it } from 'vitest';
import { loadExternalPlugins } from '../../src/plugins/external.js';
import { PluginRegistry } from '../../src/plugins/registry.js';

function silentLogger(): Logger<ILogObj> {
  return {
    info() {},
    warn() {},
    error() {},
  } as unknown as Logger<ILogObj>;
}

function writePlugin(rootDir: string, folderName: string, moduleBody: string): void {
  const pluginDir = join(rootDir, folderName);
  mkdirSync(join(pluginDir, 'dist'), { recursive: true });
  writeFileSync(
    join(pluginDir, 'package.json'),
    JSON.stringify({ name: `@goldpan/${folderName}`, version: '0.1.0' }, null, 2),
  );
  writeFileSync(join(pluginDir, 'dist', 'index.js'), moduleBody);
}

describe('loadExternalPlugins: llm-provider plugins', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  it('loads a valid llm-provider plugin', async () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), 'goldpan-plugins-'));
    tempDirs.push(pluginsDir);
    writePlugin(
      pluginsDir,
      'llm-noop',
      `
        export const goldpanPlugin = {
          name: 'llm-noop',
          version: '0.1.0',
          type: 'llm-provider',
          description: 'No-op llm provider',
          providerId: 'noop',
          createProvider: () => ({ languageModel: () => ({ provider: 'noop' }) }),
        };
      `,
    );
    const registry = new PluginRegistry();
    await loadExternalPlugins({
      pluginsDir,
      logger: silentLogger(),
      pluginRegistry: registry,
    });
    expect(registry.getLlmProviderPlugins().map((p) => p.name)).toContain('llm-noop');
  });

  it('skips a llm-provider plugin with invalid providerId (uppercase)', async () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), 'goldpan-plugins-'));
    tempDirs.push(pluginsDir);
    writePlugin(
      pluginsDir,
      'llm-bad',
      `
        export const goldpanPlugin = {
          name: 'llm-bad',
          version: '0.1.0',
          type: 'llm-provider',
          description: 'Bad provider id',
          providerId: 'BadID',
          createProvider: () => ({ languageModel: () => ({}) }),
        };
      `,
    );
    const registry = new PluginRegistry();
    await loadExternalPlugins({
      pluginsDir,
      logger: silentLogger(),
      pluginRegistry: registry,
    });
    expect(registry.getLlmProviderPlugins()).toHaveLength(0);
  });
});
