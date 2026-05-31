import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectorError } from '../../src/plugins/errors.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import type {
  CollectorOutput,
  CollectorPlugin,
  IntentPlugin,
  LlmProviderPlugin,
  PluginContext,
} from '../../src/plugins/types.js';

function createMockPlugin(overrides: Partial<CollectorPlugin> = {}): CollectorPlugin {
  return {
    name: 'test-collector',
    version: '1.0.0',
    type: 'collector',
    description: 'Test collector plugin',
    priority: 0,
    canHandle: () => true,
    collect: vi.fn().mockResolvedValue({
      content: 'test content',
      title: 'Test',
      metadata: { collector_finalUrl: 'https://example.com' },
      finalUrl: 'https://example.com',
    }),
    ...overrides,
  };
}

describe('PluginRegistry', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  describe('register', () => {
    it('registers a collector plugin', () => {
      const plugin = createMockPlugin();
      registry.register(plugin);
      expect(registry.getCollectors()).toHaveLength(1);
      expect(registry.getCollectors()[0]).toBe(plugin);
    });

    it('sorts collectors by priority descending (higher first)', () => {
      const low = createMockPlugin({ name: 'low', priority: 0 });
      const high = createMockPlugin({ name: 'high', priority: 10 });
      const mid = createMockPlugin({ name: 'mid', priority: 5 });

      registry.register(low);
      registry.register(high);
      registry.register(mid);

      const collectors = registry.getCollectors();
      expect(collectors[0].name).toBe('high');
      expect(collectors[1].name).toBe('mid');
      expect(collectors[2].name).toBe('low');
    });

    it('rejects duplicate plugin names', () => {
      registry.register(createMockPlugin({ name: 'my-collector' }));
      expect(() => registry.register(createMockPlugin({ name: 'my-collector' }))).toThrow(
        /already registered/,
      );
      expect(registry.getCollectors()).toHaveLength(1);
    });

    it('ignores plugins with unknown type', () => {
      const unknown = {
        name: 'unknown',
        version: '1.0.0',
        type: 'unknown' as any,
        description: 'x',
      };
      registry.register(unknown);
      expect(registry.getCollectors()).toHaveLength(0);
    });
  });

  describe('matchCollector', () => {
    it('returns first matching collector by priority', async () => {
      const low = createMockPlugin({ name: 'low', priority: 0, canHandle: () => true });
      const high = createMockPlugin({ name: 'high', priority: 10, canHandle: () => true });
      registry.register(low);
      registry.register(high);

      const match = await registry.matchCollector({ url: 'https://example.com' });
      expect(match?.name).toBe('high');
    });

    it('skips non-matching collectors', async () => {
      const noMatch = createMockPlugin({
        name: 'no-match',
        priority: 10,
        canHandle: () => false,
      });
      const match = createMockPlugin({ name: 'match', priority: 0, canHandle: () => true });
      registry.register(noMatch);
      registry.register(match);

      const result = await registry.matchCollector({ url: 'https://example.com' });
      expect(result?.name).toBe('match');
    });

    it('returns null when no collector matches', async () => {
      const plugin = createMockPlugin({ canHandle: () => false });
      registry.register(plugin);

      const result = await registry.matchCollector({ url: 'ftp://example.com' });
      expect(result).toBeNull();
    });

    it('returns null for empty registry', async () => {
      const result = await registry.matchCollector({ url: 'https://example.com' });
      expect(result).toBeNull();
    });

    it('handles async canHandle', async () => {
      const plugin = createMockPlugin({
        canHandle: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return true;
        },
      });
      registry.register(plugin);

      const result = await registry.matchCollector({ url: 'https://example.com' });
      expect(result?.name).toBe('test-collector');
    });

    it('handles async canHandle that rejects', async () => {
      const plugin = createMockPlugin({
        canHandle: async () => {
          throw new Error('canHandle failed');
        },
      });
      registry.register(plugin);

      await expect(registry.matchCollector({ url: 'https://example.com' })).rejects.toThrow(
        'canHandle failed',
      );
    });
  });

  describe('listMatchingCollectorNames', () => {
    it('returns canHandle matches in priority order (high first)', async () => {
      const low = createMockPlugin({ name: 'low', priority: 0, canHandle: () => true });
      const high = createMockPlugin({ name: 'high', priority: 10, canHandle: () => true });
      registry.register(low);
      registry.register(high);

      await expect(registry.listMatchingCollectorNames('https://example.com')).resolves.toEqual([
        'high',
        'low',
      ]);
    });

    it('returns empty when no match', async () => {
      registry.register(createMockPlugin({ canHandle: () => false }));
      await expect(registry.listMatchingCollectorNames('https://example.com')).resolves.toEqual([]);
    });

    it('supports async canHandle plugins', async () => {
      registry.register(
        createMockPlugin({
          canHandle: async () => true,
        }),
      );
      await expect(registry.listMatchingCollectorNames('https://example.com')).resolves.toEqual([
        'test-collector',
      ]);
    });
  });

  describe('getCollector (Phase 4 adapter)', () => {
    it('returns adapter wrapping matched collector', async () => {
      registry.register(createMockPlugin({ canHandle: () => true }));

      const adapter = await registry.getCollector('https://example.com');

      expect(adapter).toBeDefined();
      expect(typeof adapter?.collect).toBe('function');
    });

    it('returns undefined when no collector matches', async () => {
      registry.register(createMockPlugin({ canHandle: () => false }));

      const adapter = await registry.getCollector('ftp://example.com');
      expect(adapter).toBeUndefined();
    });

    it('returns undefined for empty registry', async () => {
      const adapter = await registry.getCollector('https://example.com');
      expect(adapter).toBeUndefined();
    });

    it('adapter.collect calls underlying plugin with AbortSignal', async () => {
      let capturedSignal: AbortSignal | undefined;
      const plugin = createMockPlugin({
        canHandle: () => true,
        collect: vi.fn(async (_input, signal) => {
          capturedSignal = signal;
          return {
            content: 'md content',
            title: 'Title',
            metadata: { collector_author: 'Jane' },
            finalUrl: 'https://example.com/final',
          };
        }),
      });
      registry.register(plugin);

      const adapter = await registry.getCollector('https://example.com');
      await adapter?.collect();

      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal?.aborted).toBe(false);
    });

    it('adapter passes through plugin metadata (no unprefixed finalUrl injection)', async () => {
      const plugin = createMockPlugin({
        canHandle: () => true,
        collect: vi.fn().mockResolvedValue({
          content: 'markdown',
          title: 'Title',
          metadata: { collector_author: 'Jane', collector_finalUrl: 'https://example.com/final' },
          finalUrl: 'https://example.com/final',
        }),
      });
      registry.register(plugin);

      const adapter = await registry.getCollector('https://example.com');
      const result = await adapter?.collect();

      expect(result.metadata.collector_author).toBe('Jane');
      expect(result.metadata.collector_finalUrl).toBe('https://example.com/final');
      expect(result.metadata.collectorPlugin).toBe('test-collector');
      expect(result.metadata.finalUrl).toBeUndefined();
      expect(result).toEqual({
        content: 'markdown',
        title: 'Title',
        metadata: {
          collector_author: 'Jane',
          collector_finalUrl: 'https://example.com/final',
          collectorPlugin: 'test-collector',
        },
      });
    });

    it('adapter uses configured collectTimeout for AbortController', async () => {
      const plugin = createMockPlugin({
        canHandle: () => true,
        collect: vi.fn(async (_input, signal) => {
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
            setTimeout(
              () =>
                _resolve({
                  content: 'x',
                  title: null,
                  metadata: {},
                  finalUrl: 'https://example.com',
                }),
              5000,
            );
          });
        }),
      });

      registry = new PluginRegistry({ collectTimeoutSeconds: 0.05 });
      registry.register(plugin);

      const adapter = await registry.getCollector('https://example.com');
      await expect(adapter?.collect()).rejects.toThrow();
    });

    it('supports plugins with async canHandle', async () => {
      registry.register(
        createMockPlugin({
          canHandle: async () => true,
        }),
      );

      const adapter = await registry.getCollector('https://example.com');
      expect(adapter).toBeDefined();
    });

    it('selects highest-priority matching collector', async () => {
      const low = createMockPlugin({ name: 'low', priority: 0, canHandle: () => true });
      const high = createMockPlugin({ name: 'high', priority: 10, canHandle: () => true });
      registry.register(low);
      registry.register(high);

      const adapter = await registry.getCollector('https://example.com');
      expect(adapter).toBeDefined();
      await adapter?.collect();
      expect(high.collect).toHaveBeenCalled();
      expect(low.collect).not.toHaveBeenCalled();
    });

    it('falls back to the next matching collector when a higher-priority collector fails', async () => {
      const high = createMockPlugin({
        name: 'high',
        priority: 10,
        canHandle: () => true,
        collect: vi.fn().mockRejectedValue(new Error('browser failed')),
      });
      const low = createMockPlugin({
        name: 'low',
        priority: 0,
        canHandle: () => true,
        collect: vi.fn().mockResolvedValue({
          content: 'fallback content',
          title: 'Fallback',
          metadata: { collector_finalUrl: 'https://example.com/fallback' },
          finalUrl: 'https://example.com/fallback',
        }),
      });
      registry.register(low);
      registry.register(high);

      const adapter = await registry.getCollector('https://example.com');
      const result = await adapter?.collect();

      expect(high.collect).toHaveBeenCalledOnce();
      expect(low.collect).toHaveBeenCalledOnce();
      expect(result).toEqual({
        content: 'fallback content',
        title: 'Fallback',
        metadata: { collector_finalUrl: 'https://example.com/fallback', collectorPlugin: 'low' },
      });
    });

    it('emits collect diagnostic when falling back after a collector failure', async () => {
      const { runWithCollectDiagnostics } = await import(
        '../../src/plugins/collect-diagnostics.js'
      );
      const high = createMockPlugin({
        name: 'collector-browser',
        priority: 10,
        canHandle: () => true,
        collect: vi.fn().mockRejectedValue(new Error('playwright not installed')),
      });
      const low = createMockPlugin({
        name: 'collector-web',
        priority: 0,
        canHandle: () => true,
        collect: vi.fn().mockResolvedValue({
          content: 'x'.repeat(60),
          title: 'T',
          metadata: {},
          finalUrl: 'https://example.com/',
        }),
      });
      registry.register(low);
      registry.register(high);

      const lines: string[] = [];
      const adapter = await registry.getCollector('https://example.com');
      await runWithCollectDiagnostics(
        (line) => lines.push(line),
        () => adapter!.collect(),
      );

      expect(lines.some((l) => l.includes('collector-browser') && l.includes('trying next'))).toBe(
        true,
      );
      expect(lines.some((l) => l.includes('playwright not installed'))).toBe(true);
    });

    it('throws AggregateError when all matching collectors fail', async () => {
      const high = createMockPlugin({
        name: 'high',
        priority: 10,
        canHandle: () => true,
        collect: vi.fn().mockRejectedValue(new Error('browser failed')),
      });
      const low = createMockPlugin({
        name: 'low',
        priority: 0,
        canHandle: () => true,
        collect: vi.fn().mockRejectedValue(new Error('html failed')),
      });
      registry.register(low);
      registry.register(high);

      const adapter = await registry.getCollector('https://example.com');

      await expect(adapter?.collect()).rejects.toMatchObject({
        name: 'AggregateError',
        errors: [expect.any(Error), expect.any(Error)],
      });
    });
  });

  describe('lifecycle', () => {
    it('initializes all plugins with context', async () => {
      const init1 = vi.fn().mockResolvedValue(undefined);
      const init2 = vi.fn().mockResolvedValue(undefined);
      registry.register(createMockPlugin({ name: 'p1', initialize: init1 }));
      registry.register(createMockPlugin({ name: 'p2', initialize: init2 }));

      const context: PluginContext = {
        logger: {} as any,
        pluginConfig: { httpTimeout: 30 },
      };
      await registry.initializeAll(context);

      expect(init1).toHaveBeenCalledWith(context, undefined);
      expect(init2).toHaveBeenCalledWith(context, undefined);
    });

    it('skips plugins without initialize', async () => {
      registry.register(createMockPlugin({ initialize: undefined }));
      const context: PluginContext = { logger: {} as any, pluginConfig: {} };
      await expect(registry.initializeAll(context)).resolves.toBeUndefined();
    });

    it('continues initializing remaining plugins when one fails', async () => {
      const init1 = vi.fn().mockRejectedValue(new Error('init failed'));
      const init2 = vi.fn().mockResolvedValue(undefined);
      registry.register(createMockPlugin({ name: 'p1', initialize: init1 }));
      registry.register(createMockPlugin({ name: 'p2', initialize: init2 }));

      const context: PluginContext = { logger: {} as any, pluginConfig: {} };
      await expect(registry.initializeAll(context)).rejects.toThrow(
        /1 plugin\(s\) failed to initialize/,
      );

      expect(init1).toHaveBeenCalled();
      expect(init2).toHaveBeenCalled();
    });

    it('destroys all plugins', async () => {
      const destroy1 = vi.fn().mockResolvedValue(undefined);
      const destroy2 = vi.fn().mockResolvedValue(undefined);
      registry.register(createMockPlugin({ name: 'p1', destroy: destroy1 }));
      registry.register(createMockPlugin({ name: 'p2', destroy: destroy2 }));

      await registry.initializeAll({
        logger: { info() {}, warn() {}, error() {} } as any,
        pluginConfig: {},
      });
      await registry.destroyAll();

      expect(destroy1).toHaveBeenCalled();
      expect(destroy2).toHaveBeenCalled();
    });

    it('skips plugins without destroy', async () => {
      registry.register(createMockPlugin({ destroy: undefined }));
      await expect(registry.destroyAll()).resolves.toBeUndefined();
    });

    it('continues destroying remaining plugins when one fails', async () => {
      const destroy1 = vi.fn().mockRejectedValue(new Error('cleanup failed'));
      const destroy2 = vi.fn().mockResolvedValue(undefined);
      registry.register(createMockPlugin({ name: 'p1', destroy: destroy1 }));
      registry.register(createMockPlugin({ name: 'p2', destroy: destroy2 }));

      await registry.initializeAll({
        logger: { info() {}, warn() {}, error() {} } as any,
        pluginConfig: {},
      });
      await expect(registry.destroyAll()).rejects.toThrow(/1 plugin\(s\) failed to destroy/);

      // Both destroy methods were called despite p1 failing
      expect(destroy1).toHaveBeenCalled();
      expect(destroy2).toHaveBeenCalled();
    });
  });

  describe('intent plugin support', () => {
    function createTestIntentPlugin(
      name: string,
      intents: {
        name: string;
        description: string;
        priority?: number;
        maxInputLength?: number;
      }[] = [{ name: 'test_intent', description: 'A test intent' }],
    ): IntentPlugin {
      return {
        name,
        version: '1.0.0',
        type: 'intent' as const,
        description: 'Test intent plugin',
        intents: intents.map((i) => ({ ...i })),
        execute: vi.fn().mockResolvedValue({
          type: 'submit',
          result: { status: 'accepted', taskId: 1, sourceId: 1, warnings: [] },
        }),
      };
    }

    it('registers an intent plugin', () => {
      const registry = new PluginRegistry();
      const plugin = createTestIntentPlugin('test-intent');
      registry.register(plugin);
      expect(registry.getIntentPlugins()).toHaveLength(1);
      expect(registry.getIntentPlugins()[0].name).toBe('test-intent');
    });

    it('rejects duplicate intent plugin names', () => {
      const registry = new PluginRegistry();
      registry.register(createTestIntentPlugin('test-intent'));
      expect(() => registry.register(createTestIntentPlugin('test-intent'))).toThrow(
        'Plugin "test-intent" is already registered',
      );
    });

    it('rejects duplicate intent names within the same plugin', () => {
      const registry = new PluginRegistry();
      expect(() =>
        registry.register(
          createTestIntentPlugin('bad-plugin', [
            { name: 'dup', description: 'A' },
            { name: 'dup', description: 'B' },
          ]),
        ),
      ).toThrow('Plugin "bad-plugin" declares duplicate intent name "dup"');
    });

    it('rejects same-priority intent name conflict across plugins', () => {
      const registry = new PluginRegistry();
      registry.register(
        createTestIntentPlugin('plugin-a', [{ name: 'shared_intent', description: 'A' }]),
      );
      expect(() =>
        registry.register(
          createTestIntentPlugin('plugin-b', [{ name: 'shared_intent', description: 'B' }]),
        ),
      ).toThrow(
        'Intent "shared_intent" is already registered by plugin "plugin-a" with the same priority (0)',
      );
    });

    it('getIntentDeclarations aggregates all declarations', () => {
      const registry = new PluginRegistry();
      registry.register(
        createTestIntentPlugin('plugin-a', [
          { name: 'intent_a', description: 'A' },
          { name: 'intent_b', description: 'B' },
        ]),
      );
      registry.register(
        createTestIntentPlugin('plugin-b', [{ name: 'intent_c', description: 'C' }]),
      );
      const declarations = registry.getIntentDeclarations();
      expect(declarations).toHaveLength(3);
      expect(declarations.map((d) => d.name).sort()).toEqual(['intent_a', 'intent_b', 'intent_c']);
    });

    it('getIntentNames returns all registered intent names', () => {
      const registry = new PluginRegistry();
      registry.register(
        createTestIntentPlugin('plugin-a', [
          { name: 'alpha', description: 'A' },
          { name: 'beta', description: 'B' },
        ]),
      );
      expect(registry.getIntentNames().sort()).toEqual(['alpha', 'beta']);
    });

    it('findIntentHandler returns the correct plugin', () => {
      const registry = new PluginRegistry();
      const pluginA = createTestIntentPlugin('plugin-a', [{ name: 'intent_a', description: 'A' }]);
      const pluginB = createTestIntentPlugin('plugin-b', [{ name: 'intent_b', description: 'B' }]);
      registry.register(pluginA);
      registry.register(pluginB);
      expect(registry.findIntentHandler('intent_a')).toBe(pluginA);
      expect(registry.findIntentHandler('intent_b')).toBe(pluginB);
      expect(registry.findIntentHandler('nonexistent')).toBeUndefined();
    });

    it('initializeAll calls initialize on intent plugins', async () => {
      const registry = new PluginRegistry();
      const plugin = createTestIntentPlugin('test-intent');
      plugin.initialize = vi.fn().mockResolvedValue(undefined);
      registry.register(plugin);

      await registry.initializeAll({
        logger: { info() {}, warn() {}, error() {} } as any,
        pluginConfig: {},
      });

      expect(plugin.initialize).toHaveBeenCalledTimes(1);
    });

    it('destroyAll calls destroy on intent plugins', async () => {
      const registry = new PluginRegistry();
      const plugin = createTestIntentPlugin('test-intent');
      plugin.destroy = vi.fn().mockResolvedValue(undefined);
      registry.register(plugin);

      await registry.initializeAll({
        logger: { info() {}, warn() {}, error() {} } as any,
        pluginConfig: {},
      });
      await registry.destroyAll();

      expect(plugin.destroy).toHaveBeenCalledTimes(1);
    });

    it('collectors and intent plugins coexist independently', () => {
      const registry = new PluginRegistry();
      const collector = {
        name: 'test-collector',
        version: '1.0.0',
        type: 'collector' as const,
        description: 'Test',
        priority: 5,
        canHandle: () => true,
        collect: vi.fn(),
      };
      const intent = createTestIntentPlugin('test-intent');
      registry.register(collector);
      registry.register(intent);
      expect(registry.getCollectors()).toHaveLength(1);
      expect(registry.getIntentPlugins()).toHaveLength(1);
    });

    it('findIntentDeclaration returns full registration', () => {
      const registry = new PluginRegistry();
      const plugin = createTestIntentPlugin('plugin-a', [
        { name: 'alpha', description: 'Alpha desc', maxInputLength: 500 },
      ]);
      registry.register(plugin);
      const reg = registry.findIntentDeclaration('alpha');
      expect(reg).toBeDefined();
      expect(reg!.plugin).toBe(plugin);
      expect(reg!.declaration.name).toBe('alpha');
      expect(reg!.declaration.maxInputLength).toBe(500);
    });

    it('findIntentDeclaration returns undefined for unknown name', () => {
      const registry = new PluginRegistry();
      expect(registry.findIntentDeclaration('nonexistent')).toBeUndefined();
    });

    it('getIntentDeclarations returns only winning declarations', () => {
      const registry = new PluginRegistry();
      registry.register(
        createTestIntentPlugin('low', [{ name: 'shared', description: 'Low', priority: 0 }]),
      );
      registry.register(
        createTestIntentPlugin('high', [{ name: 'shared', description: 'High', priority: 10 }]),
      );
      const decls = registry.getIntentDeclarations();
      expect(decls).toHaveLength(1);
      expect(decls[0].description).toBe('High');
    });
  });

  describe('intent priority arbitration', () => {
    function createTestIntentPlugin(
      name: string,
      intents: {
        name: string;
        description: string;
        priority?: number;
        maxInputLength?: number;
      }[] = [{ name: 'test_intent', description: 'A test intent' }],
    ): IntentPlugin {
      return {
        name,
        version: '1.0.0',
        type: 'intent' as const,
        description: `Intent plugin ${name}`,
        intents: intents.map((i) => ({ ...i })),
        execute: vi.fn().mockResolvedValue({
          type: 'submit',
          result: { status: 'accepted', taskId: 1, sourceId: 1, warnings: [] },
        }),
      };
    }

    it('higher priority plugin wins for same intent name', () => {
      const registry = new PluginRegistry();
      const low = createTestIntentPlugin('builtin', [
        { name: 'query', description: 'built-in query', priority: 0 },
      ]);
      const high = createTestIntentPlugin('external', [
        { name: 'query', description: 'custom query', priority: 10 },
      ]);
      registry.register(low);
      registry.register(high);

      expect(registry.findIntentHandler('query')).toBe(high);
      expect(registry.findIntentDeclaration('query')!.declaration.description).toBe('custom query');
    });

    it('lower priority plugin is silently skipped (intent not overridden)', () => {
      const registry = new PluginRegistry();
      const high = createTestIntentPlugin('external', [
        { name: 'query', description: 'custom query', priority: 10 },
      ]);
      const low = createTestIntentPlugin('builtin', [
        { name: 'query', description: 'built-in query', priority: 0 },
      ]);
      registry.register(high);
      registry.register(low);

      expect(registry.findIntentHandler('query')).toBe(high);
    });

    it('same priority on same intent name throws', () => {
      const registry = new PluginRegistry();
      registry.register(
        createTestIntentPlugin('plugin-a', [{ name: 'dup', description: 'A', priority: 5 }]),
      );
      expect(() =>
        registry.register(
          createTestIntentPlugin('plugin-b', [{ name: 'dup', description: 'B', priority: 5 }]),
        ),
      ).toThrow(/same priority/);
    });

    it('default priority is 0 when omitted', () => {
      const registry = new PluginRegistry();
      const noExplicit = createTestIntentPlugin('no-priority', [
        { name: 'intent_a', description: 'no explicit priority' },
      ]);
      registry.register(noExplicit);

      const withZero = createTestIntentPlugin('zero-priority', [
        { name: 'intent_a', description: 'explicit 0', priority: 0 },
      ]);
      // Same effective priority → conflict
      expect(() => registry.register(withZero)).toThrow(/same priority/);
    });

    it('override logs warning with winner/loser metadata', () => {
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as any;
      const registry = new PluginRegistry({ logger: mockLogger });

      registry.register(
        createTestIntentPlugin('builtin', [
          { name: 'query', description: 'built-in', priority: 0 },
        ]),
      );
      registry.register(
        createTestIntentPlugin('external', [
          { name: 'query', description: 'custom', priority: 10 },
        ]),
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('overridden'),
        expect.objectContaining({ winner: 'external', loser: 'builtin' }),
      );
    });

    it('lower-priority skip logs info', () => {
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as any;
      const registry = new PluginRegistry({ logger: mockLogger });

      registry.register(
        createTestIntentPlugin('external', [
          { name: 'query', description: 'custom', priority: 10 },
        ]),
      );
      registry.register(
        createTestIntentPlugin('builtin', [
          { name: 'query', description: 'built-in', priority: 0 },
        ]),
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('kept from plugin'),
        expect.objectContaining({ winner: 'external', skipped: 'builtin' }),
      );
    });

    it('multi-intent plugin: each intent arbitrated independently', () => {
      const registry = new PluginRegistry();
      registry.register(
        createTestIntentPlugin('builtin', [
          { name: 'submit_url', description: 'built-in submit', priority: 0 },
          { name: 'query', description: 'built-in query', priority: 0 },
        ]),
      );
      registry.register(
        createTestIntentPlugin('custom-query', [
          { name: 'query', description: 'custom query', priority: 10 },
        ]),
      );

      expect(registry.findIntentHandler('submit_url')!.name).toBe('builtin');
      expect(registry.findIntentHandler('query')!.name).toBe('custom-query');
      expect(registry.getIntentDeclarations()).toHaveLength(2);
    });
  });
});

// Helper for terminal-fallback tests. Builds a minimally-valid CollectorPlugin
// (CollectorOutput requires all four fields; collect signature is (input, signal)).
function makeTerminalTestCollector(
  name: string,
  priority: number,
  impl: (url: string) => Promise<CollectorOutput>,
): CollectorPlugin {
  return {
    name,
    type: 'collector',
    version: '0.0.0',
    description: `test collector ${name}`,
    priority,
    canHandle: () => true,
    collect: vi.fn(async ({ url }: { url: string }, _signal: AbortSignal) => impl(url)),
  } as unknown as CollectorPlugin;
}

describe('PluginRegistry fallback × CollectorError.terminal', () => {
  it('terminal error blocks fallback to lower-priority collector', async () => {
    const registry = new PluginRegistry();
    const lowPri = makeTerminalTestCollector('low', 5, async () => ({
      content: 'fallback',
      title: null,
      metadata: {},
      finalUrl: 'https://example.com/x',
    }));
    const highPri = makeTerminalTestCollector('high', 20, async () => {
      throw new CollectorError('nope', 'NOT_FOUND', false, undefined, true);
    });
    registry.register(lowPri);
    registry.register(highPri);

    const handle = await registry.getCollector('https://example.com/x');
    await expect(handle?.collect()).rejects.toMatchObject({
      code: 'NOT_FOUND',
      terminal: true,
    });
    expect(lowPri.collect).not.toHaveBeenCalled();
  });

  it('non-terminal error still falls back to next collector', async () => {
    const registry = new PluginRegistry();
    const lowPri = makeTerminalTestCollector('low', 5, async () => ({
      content: 'fallback content',
      title: null,
      metadata: { fellBack: true },
      finalUrl: 'https://example.com/x',
    }));
    const highPri = makeTerminalTestCollector('high', 20, async () => {
      // 4-arg constructor (terminal defaults to false) — guards default-value semantics
      throw new CollectorError('transient', 'FETCH_FAILED', true);
    });
    registry.register(lowPri);
    registry.register(highPri);

    const handle = await registry.getCollector('https://example.com/x');
    const result = await handle?.collect();
    expect(result?.content).toBe('fallback content');
    expect(lowPri.collect).toHaveBeenCalledTimes(1);
  });
});

describe('PluginRegistry: llm-provider plugins', () => {
  function makeLlmPlugin(overrides?: Partial<LlmProviderPlugin>): LlmProviderPlugin {
    return {
      name: 'llm-cohere',
      version: '0.1.0',
      type: 'llm-provider',
      description: 'Cohere LLM provider',
      providerId: 'cohere',
      createProvider: () => ({ languageModel: () => ({}) as never }),
      ...overrides,
    };
  }

  it('register llm-provider plugin makes it discoverable via getLlmProviderPlugins', () => {
    const reg = new PluginRegistry();
    const plugin = makeLlmPlugin();
    reg.register(plugin);
    expect(reg.getLlmProviderPlugins()).toEqual([plugin]);
  });

  it('rejects duplicate registration by name', () => {
    const reg = new PluginRegistry();
    reg.register(makeLlmPlugin());
    expect(() => reg.register(makeLlmPlugin())).toThrow(/already registered/);
  });

  it('hasPlugin reports llm-provider plugins', () => {
    const reg = new PluginRegistry();
    reg.register(makeLlmPlugin());
    expect(reg.hasPlugin('llm-cohere')).toBe(true);
  });

  it('recordLlmProviderStatus is reflected in getLlmProviderLoadStatus', () => {
    const reg = new PluginRegistry();
    reg.register(makeLlmPlugin());
    reg.recordLlmProviderStatus('llm-cohere', { status: 'loaded' });
    reg.recordLlmProviderStatus('llm-broken', {
      status: 'failed',
      error: 'createProvider threw: boom',
    });
    expect(reg.getLlmProviderLoadStatus()).toEqual({
      'llm-cohere': { status: 'loaded' },
      'llm-broken': { status: 'failed', error: 'createProvider threw: boom' },
    });
  });
});
