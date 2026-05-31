import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadExternalPlugins } from '../../src/plugins/external';
import { PluginRegistry } from '../../src/plugins/registry';

function writePlugin(rootDir: string, folderName: string, moduleBody: string): void {
  const pluginDir = join(rootDir, folderName);
  mkdirSync(join(pluginDir, 'dist'), { recursive: true });
  writeFileSync(
    join(pluginDir, 'package.json'),
    JSON.stringify({ name: `@goldpan/${folderName}`, version: '0.1.0' }, null, 2),
  );
  writeFileSync(join(pluginDir, 'dist', 'index.js'), moduleBody);
}

describe('loadExternalPlugins', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('loads valid external collector plugins from the convention directory', async () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), 'goldpan-plugins-'));
    tempDirs.push(pluginsDir);
    writePlugin(
      pluginsDir,
      'collector-example',
      `
        export const goldpanPlugin = {
          name: 'collector-example',
          version: '0.1.0',
          type: 'collector',
          description: 'Example plugin',
          priority: 10,
          canHandle: () => true,
          collect: async () => ({
            content: 'plugin content',
            title: 'Plugin Title',
            metadata: { collector_finalUrl: 'https://example.com' },
            finalUrl: 'https://example.com'
          })
        };
      `,
    );
    const registry = new PluginRegistry();

    const info = vi.fn();
    await loadExternalPlugins({
      pluginsDir,
      logger: { info, warn() {}, error() {} } as any,
      pluginRegistry: registry,
    });

    expect(registry.getCollectors().map((plugin) => plugin.name)).toContain('collector-example');
    expect(info).toHaveBeenCalledWith(
      'external plugins load summary',
      expect.objectContaining({
        loadedCount: 1,
        loadedPlugins: ['collector-example'],
      }),
    );
  });

  it('allows missing convention directory', async () => {
    const registry = new PluginRegistry();

    await expect(
      loadExternalPlugins({
        pluginsDir: join(tmpdir(), 'goldpan-missing-plugins'),
        logger: { info() {}, warn() {}, error() {} } as any,
        pluginRegistry: registry,
      }),
    ).resolves.toBeUndefined();
  });

  it('skips a plugin that does not export goldpanPlugin', async () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), 'goldpan-plugins-'));
    tempDirs.push(pluginsDir);
    writePlugin(pluginsDir, 'collector-invalid', 'export const nope = {};');
    const registry = new PluginRegistry();

    await loadExternalPlugins({
      pluginsDir,
      logger: { info() {}, warn() {}, error() {} } as any,
      pluginRegistry: registry,
    });

    expect(registry.getCollectors()).toHaveLength(0);
  });

  it('skips a plugin folder without package.json', async () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), 'goldpan-plugins-'));
    tempDirs.push(pluginsDir);
    const pluginDir = join(pluginsDir, 'collector-invalid');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    writeFileSync(join(pluginDir, 'dist', 'index.js'), 'export const goldpanPlugin = {};');
    const registry = new PluginRegistry();

    await loadExternalPlugins({
      pluginsDir,
      logger: { info() {}, warn() {}, error() {} } as any,
      pluginRegistry: registry,
    });

    expect(registry.getCollectors()).toHaveLength(0);
  });

  it('throws in dev/test when dist/index.js is missing (loud signal during development)', async () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), 'goldpan-plugins-'));
    tempDirs.push(pluginsDir);
    const pluginDir = join(pluginsDir, 'collector-invalid');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'package.json'),
      JSON.stringify({ name: '@goldpan/collector-invalid', version: '0.1.0' }, null, 2),
    );
    const registry = new PluginRegistry();

    await expect(
      loadExternalPlugins({
        pluginsDir,
        logger: { info() {}, warn() {}, error() {} } as any,
        pluginRegistry: registry,
      }),
    ).rejects.toThrow(/Plugin entry missing/);
  });

  it('aggregates import failures alongside missing entries (dev/test) so a corrupted build also surfaces in the same error', async () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), 'goldpan-plugins-'));
    tempDirs.push(pluginsDir);
    // Plugin A: missing dist/index.js entirely.
    const aDir = join(pluginsDir, 'collector-missing');
    mkdirSync(aDir, { recursive: true });
    writeFileSync(
      join(aDir, 'package.json'),
      JSON.stringify({ name: '@goldpan/collector-missing', version: '0.1.0' }, null, 2),
    );
    // Plugin B: dist exists but the JS throws on import.
    writePlugin(pluginsDir, 'collector-broken', `throw new Error('module init exploded');`);
    const registry = new PluginRegistry();

    let caught: Error | null = null;
    try {
      await loadExternalPlugins({
        pluginsDir,
        logger: { info() {}, warn() {}, error() {} } as any,
        pluginRegistry: registry,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught?.message ?? '';
    expect(message).toMatch(/Plugin entry missing — 1 plugin/);
    expect(message).toMatch(/Plugin import failed — 1 plugin/);
    expect(message).toContain('collector-missing');
    expect(message).toContain('collector-broken');
    expect(message).toContain('module init exploded');
  });

  it('aggregates all missing entries into a single error so a clean checkout sees the full list', async () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), 'goldpan-plugins-'));
    tempDirs.push(pluginsDir);
    for (const folderName of ['collector-a', 'collector-b', 'collector-c']) {
      const pluginDir = join(pluginsDir, folderName);
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(
        join(pluginDir, 'package.json'),
        JSON.stringify({ name: `@goldpan/${folderName}`, version: '0.1.0' }, null, 2),
      );
    }
    const registry = new PluginRegistry();

    let caught: Error | null = null;
    try {
      await loadExternalPlugins({
        pluginsDir,
        logger: { info() {}, warn() {}, error() {} } as any,
        pluginRegistry: registry,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught?.message ?? '';
    expect(message).toMatch(/3 plugin\(s\) lack a built dist\/index\.js/);
    expect(message).toContain('collector-a');
    expect(message).toContain('collector-b');
    expect(message).toContain('collector-c');
    expect(message).toMatch(/pnpm dev:prebuild/);
  });

  it('warns only in production when dist/index.js is missing (avoids bringing down a running deploy)', async () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), 'goldpan-plugins-'));
    tempDirs.push(pluginsDir);
    const pluginDir = join(pluginsDir, 'collector-invalid');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'package.json'),
      JSON.stringify({ name: '@goldpan/collector-invalid', version: '0.1.0' }, null, 2),
    );
    const registry = new PluginRegistry();
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await loadExternalPlugins({
        pluginsDir,
        logger: { info() {}, warn() {}, error() {} } as any,
        pluginRegistry: registry,
      });
      expect(registry.getCollectors()).toHaveLength(0);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('registers only the first folder when duplicate plugin names are exported', async () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), 'goldpan-plugins-'));
    tempDirs.push(pluginsDir);
    const moduleBody = `
      export const goldpanPlugin = {
        name: 'collector-duplicate',
        version: '0.1.0',
        type: 'collector',
        description: 'Duplicate plugin',
        priority: 5,
        canHandle: () => true,
        collect: async () => ({
          content: 'plugin content',
          title: 'Plugin Title',
          metadata: { collector_finalUrl: 'https://example.com' },
          finalUrl: 'https://example.com'
        })
      };
    `;
    writePlugin(pluginsDir, 'collector-one', moduleBody);
    writePlugin(pluginsDir, 'collector-two', moduleBody);
    const registry = new PluginRegistry();

    await loadExternalPlugins({
      pluginsDir,
      logger: { info() {}, warn() {}, error() {} } as any,
      pluginRegistry: registry,
    });

    expect(registry.getCollectors().filter((c) => c.name === 'collector-duplicate')).toHaveLength(
      1,
    );
  });

  it('loads valid external intent plugins', async () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), 'goldpan-plugins-'));
    tempDirs.push(pluginsDir);
    writePlugin(
      pluginsDir,
      'intent-custom',
      `
        export const goldpanPlugin = {
          name: 'intent-custom',
          version: '0.1.0',
          type: 'intent',
          description: 'Custom intent plugin',
          intents: [{ name: 'custom_intent', description: 'A custom intent' }],
          execute: async () => ({ type: 'submit', result: { status: 'accepted', taskId: 1, sourceId: 1, warnings: [] } })
        };
      `,
    );
    const registry = new PluginRegistry();
    const info = vi.fn();

    await loadExternalPlugins({
      pluginsDir,
      logger: { info, warn() {}, error() {} } as any,
      pluginRegistry: registry,
    });

    expect(registry.getIntentPlugins().map((p) => p.name)).toContain('intent-custom');
    expect(info).toHaveBeenCalledWith(
      'external plugins load summary',
      expect.objectContaining({
        loadedCount: 1,
        loadedPlugins: ['intent-custom'],
      }),
    );
  });

  it('skips plugins with unsupported type', async () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), 'goldpan-plugins-'));
    tempDirs.push(pluginsDir);
    writePlugin(
      pluginsDir,
      'plugin-unknown',
      `
        export const goldpanPlugin = {
          name: 'plugin-unknown',
          version: '0.1.0',
          type: 'transformer',
          description: 'Unknown type plugin',
        };
      `,
    );
    const registry = new PluginRegistry();
    const warn = vi.fn();

    await loadExternalPlugins({
      pluginsDir,
      logger: { info() {}, warn, error() {} } as any,
      pluginRegistry: registry,
    });

    expect(registry.getCollectors()).toHaveLength(0);
    expect(registry.getIntentPlugins()).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      'skipping plugin with unsupported type',
      expect.objectContaining({ pluginFolder: expect.stringContaining('plugin-unknown') }),
    );
  });

  it('rejects intent plugin with malformed intents array', async () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), 'goldpan-plugins-'));
    tempDirs.push(pluginsDir);
    writePlugin(
      pluginsDir,
      'intent-bad',
      `
        export const goldpanPlugin = {
          name: 'intent-bad',
          version: '0.1.0',
          type: 'intent',
          description: 'Malformed intent plugin',
          intents: [{ notName: 'oops' }],
          execute: async () => ({ type: 'content', text: 'hello' })
        };
      `,
    );
    const registry = new PluginRegistry();
    const warn = vi.fn();

    await loadExternalPlugins({
      pluginsDir,
      logger: { info() {}, warn, error() {} } as any,
      pluginRegistry: registry,
    });

    expect(registry.getIntentPlugins()).toHaveLength(0);
  });

  it('loads valid external tool plugin', async () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), 'goldpan-plugins-'));
    tempDirs.push(pluginsDir);
    writePlugin(
      pluginsDir,
      'tool-test',
      `
        export const goldpanPlugin = {
          name: 'tool-test',
          version: '1.0.0',
          type: 'tool',
          description: 'Test tool',
          priority: 10,
          tools: [{ name: 'search', description: 'Search', inputSchema: { parse: (v) => v }, outputSchema: { parse: (v) => v } }],
          executeTool: async () => ({}),
        };
      `,
    );
    const registry = new PluginRegistry();
    const info = vi.fn();

    await loadExternalPlugins({
      pluginsDir,
      logger: { info, warn() {}, error() {} } as any,
      pluginRegistry: registry,
    });

    expect(registry.getToolPlugins().map((p) => p.name)).toContain('tool-test');
    expect(info).toHaveBeenCalledWith(
      'external plugins load summary',
      expect.objectContaining({
        loadedCount: 1,
        loadedPlugins: ['tool-test'],
      }),
    );
  });

  it('rejects tool plugin with missing executeTool', async () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), 'goldpan-plugins-'));
    tempDirs.push(pluginsDir);
    writePlugin(
      pluginsDir,
      'tool-bad',
      `
        export const goldpanPlugin = {
          name: 'tool-bad',
          version: '1.0.0',
          type: 'tool',
          description: 'Bad tool',
          priority: 10,
          tools: [],
        };
      `,
    );
    const registry = new PluginRegistry();

    await loadExternalPlugins({
      pluginsDir,
      logger: { info() {}, warn() {}, error() {} } as any,
      pluginRegistry: registry,
    });

    expect(registry.getToolPlugins()).toHaveLength(0);
  });

  it('skips directories whose name starts with im-', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'goldpan-im-skip-'));
    try {
      mkdirSync(join(tempDir, 'im-fake', 'dist'), { recursive: true });
      writeFileSync(
        join(tempDir, 'im-fake', 'package.json'),
        JSON.stringify({ name: '@goldpan/plugin-im-fake' }),
      );
      writeFileSync(
        join(tempDir, 'im-fake', 'dist', 'index.js'),
        'throw new Error("must not be imported by core loader");',
      );
      const logs: { warn: string[]; info: string[] } = { warn: [], info: [] };
      const logger = {
        info: (msg: string) => logs.info.push(msg),
        warn: (msg: string) => logs.warn.push(msg),
        error: () => {},
      };
      const registry = new PluginRegistry({ logger: logger as never });
      await loadExternalPlugins({ pluginsDir: tempDir, logger, pluginRegistry: registry });
      expect(logs.warn.some((m) => m.includes('failed to import'))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('skips directories whose name starts with web-', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'goldpan-web-skip-'));
    try {
      mkdirSync(join(tempDir, 'web-fake', 'dist'), { recursive: true });
      writeFileSync(
        join(tempDir, 'web-fake', 'package.json'),
        JSON.stringify({ name: '@goldpan/plugin-web-fake' }),
      );
      writeFileSync(
        join(tempDir, 'web-fake', 'dist', 'index.js'),
        'throw new Error("must not be imported by core loader");',
      );
      const logs: { warn: string[]; info: string[] } = { warn: [], info: [] };
      const logger = {
        info: (msg: string) => logs.info.push(msg),
        warn: (msg: string) => logs.warn.push(msg),
        error: () => {},
      };
      const registry = new PluginRegistry({ logger: logger as never });
      await loadExternalPlugins({ pluginsDir: tempDir, logger, pluginRegistry: registry });
      expect(logs.warn.some((m) => m.includes('failed to import'))).toBe(false);
      expect(registry.getCollectors()).toHaveLength(0);
      expect(registry.getIntentPlugins()).toHaveLength(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects tool plugin with non-function inputSchema.parse', async () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), 'goldpan-plugins-'));
    tempDirs.push(pluginsDir);
    writePlugin(
      pluginsDir,
      'tool-schema',
      `
        export const goldpanPlugin = {
          name: 'tool-schema',
          version: '1.0.0',
          type: 'tool',
          description: 'Schema test',
          priority: 10,
          tools: [{ name: 'search', description: 'S', inputSchema: { parse: 'not-a-function' }, outputSchema: { parse: (v) => v } }],
          executeTool: async () => ({}),
        };
      `,
    );
    const registry = new PluginRegistry();

    await loadExternalPlugins({
      pluginsDir,
      logger: { info() {}, warn() {}, error() {} } as any,
      pluginRegistry: registry,
    });

    expect(registry.getToolPlugins()).toHaveLength(0);
  });

  /**
   * Spike: verifies the two-package pattern that github-collector +
   * github-intent will use. Documents the invariants that the design depends on:
   *   I1. Both packages are loaded by external loader as separate goldpanPlugins
   *   I2. initializeAll runs collectors before intent plugins (registry.ts:325)
   *   I3. registerService in collector.initialize is visible from intent.initialize
   *   I4. destroyAll clears serviceProviders (registry.ts:382)
   * If any of these break in the future, github-intent loses access to the
   * shared service and Phase 1 spec §6.4 invariants must be revisited.
   */
  it('two-package pattern: collector registers service, intent consumes it', async () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), 'goldpan-plugins-'));
    tempDirs.push(pluginsDir);

    writePlugin(
      pluginsDir,
      'shared-collector',
      `
        export const goldpanPlugin = {
          name: 'shared-collector',
          version: '0.1.0',
          type: 'collector',
          description: 'Collector that owns a shared service',
          priority: 10,
          requiredCapabilities: ['pluginRegistry'],
          canHandle: () => false,
          collect: async () => ({ content: '', title: '', metadata: {} }),
          initialize: async (_ctx, caps) => {
            caps.pluginRegistry.registerService('shared-svc', {
              fetchData: () => 'collector-owned-data',
            });
          },
        };
      `,
    );

    writePlugin(
      pluginsDir,
      'shared-intent',
      `
        export const goldpanPlugin = {
          name: 'shared-intent',
          version: '0.1.0',
          type: 'intent',
          description: 'Intent that consumes the shared service',
          requiredCapabilities: ['pluginRegistry'],
          intents: [{ name: 'use_shared', description: 'Use shared svc' }],
          execute: async () => ({ type: 'action', message: 'ok' }),
          initialize: async (_ctx, caps) => {
            const svc = caps.pluginRegistry.getService('shared-svc');
            if (!svc) {
              throw new Error('Shared service not registered before intent init');
            }
            svc.__intentInitialized = true;
          },
        };
      `,
    );

    const registry = new PluginRegistry();
    await loadExternalPlugins({
      pluginsDir,
      logger: { info() {}, warn() {}, error() {} } as any,
      pluginRegistry: registry,
    });

    expect(registry.getCollectors().map((p) => p.name)).toContain('shared-collector');
    expect(registry.getIntentPlugins().map((p) => p.name)).toContain('shared-intent');

    await registry.initializeAll(
      { logger: { info() {}, warn() {}, error() {}, debug() {} } as any },
      { pluginRegistry: registry } as any,
    );

    const svc = registry.getService<{ fetchData(): string; __intentInitialized?: boolean }>(
      'shared-svc',
    );
    expect(svc).toBeDefined();
    expect(svc?.fetchData()).toBe('collector-owned-data');
    expect(svc?.__intentInitialized).toBe(true);

    await registry.destroyAll();
    expect(registry.getService('shared-svc')).toBeUndefined();
  });
});
