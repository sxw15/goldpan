import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolOutputValidationError } from '../../src/plugins/errors';
import { PluginRegistry } from '../../src/plugins/registry';
import type { ToolDeclaration, ToolPlugin } from '../../src/plugins/types';

const inputSchema = z.object({ query: z.string() });
const outputSchema = z.object({ results: z.array(z.object({ url: z.string() })) });

function makeToolPlugin(name: string, priority: number, tools?: ToolDeclaration[]): ToolPlugin {
  return {
    name,
    version: '1.0.0',
    type: 'tool',
    description: `${name} plugin`,
    priority,
    tools: tools ?? [{ name: 'search', description: 'Search', inputSchema, outputSchema }],
    async executeTool(_toolName: string, _input: unknown) {
      return { results: [{ url: 'https://example.com' }] };
    },
  };
}

describe('PluginRegistry — tool plugins', () => {
  let registry: PluginRegistry;
  beforeEach(() => {
    registry = new PluginRegistry();
  });

  it('registers and retrieves tool plugins', () => {
    registry.register(makeToolPlugin('tool-a', 10));
    expect(registry.getToolPlugins()).toHaveLength(1);
  });

  it('rejects duplicate plugin names', () => {
    registry.register(makeToolPlugin('tool-a', 10));
    expect(() => registry.register(makeToolPlugin('tool-a', 20))).toThrow('already registered');
  });

  it('resolveToolProvider finds specific plugin + tool', () => {
    registry.register(makeToolPlugin('tool-a', 10));
    const match = registry.resolveToolProvider('tool-a', 'search');
    expect(match).toBeDefined();
    expect(match!.plugin.name).toBe('tool-a');
    expect(match!.declaration.name).toBe('search');
  });

  it('resolveToolProvider returns undefined for unknown', () => {
    expect(registry.resolveToolProvider('nope', 'search')).toBeUndefined();
  });

  it('listToolCandidates returns sorted by priority (desc)', () => {
    registry.register(makeToolPlugin('low', 5));
    registry.register(makeToolPlugin('high', 20));
    registry.register(makeToolPlugin('mid', 15));
    const candidates = registry.listToolCandidates('search');
    expect(candidates.map((c) => c.plugin.name)).toEqual(['high', 'mid', 'low']);
  });

  it('listToolCandidates returns empty for unknown tool', () => {
    registry.register(makeToolPlugin('tool-a', 10));
    expect(registry.listToolCandidates('unknown')).toEqual([]);
  });

  it('listToolCandidates reads tools lazily (at call time)', () => {
    const plugin = makeToolPlugin('lazy', 10, []);
    registry.register(plugin);
    expect(registry.listToolCandidates('search')).toEqual([]);
    // Simulate lazy population during initialize()
    plugin.tools.push({ name: 'search', description: 'Search', inputSchema, outputSchema });
    const candidates = registry.listToolCandidates('search');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].plugin.name).toBe('lazy');
  });
});

describe('PluginRegistry — executeToolValidated', () => {
  let registry: PluginRegistry;
  beforeEach(() => {
    registry = new PluginRegistry();
  });

  it('validates input and output', async () => {
    registry.register(makeToolPlugin('tool-a', 10));
    const result = await registry.executeToolValidated('tool-a', 'search', { query: 'test' });
    expect(result).toEqual({ results: [{ url: 'https://example.com' }] });
  });

  it('throws on invalid input', async () => {
    registry.register(makeToolPlugin('tool-a', 10));
    await expect(
      registry.executeToolValidated('tool-a', 'search', { query: 123 }),
    ).rejects.toThrow();
  });

  it('throws ToolOutputValidationError on invalid output', async () => {
    const plugin = makeToolPlugin('tool-bad', 10);
    plugin.executeTool = async () => ({ badField: true }); // invalid output
    registry.register(plugin);
    await expect(
      registry.executeToolValidated('tool-bad', 'search', { query: 'test' }),
    ).rejects.toBeInstanceOf(ToolOutputValidationError);
  });

  it('throws on unknown plugin/tool', async () => {
    await expect(registry.executeToolValidated('nope', 'search', {})).rejects.toThrow('not found');
  });
});

describe('PluginRegistry — executeToolWithFallback', () => {
  let registry: PluginRegistry;
  beforeEach(() => {
    registry = new PluginRegistry();
  });

  it('returns first successful result by priority', async () => {
    const high = makeToolPlugin('high', 20);
    high.executeTool = async () => ({ results: [{ url: 'https://high.com' }] });
    registry.register(high);
    registry.register(makeToolPlugin('low', 5));
    const result: any = await registry.executeToolWithFallback('search', { query: 'test' });
    expect(result.results[0].url).toBe('https://high.com');
  });

  it('falls back when first provider fails', async () => {
    const high = makeToolPlugin('high', 20);
    high.executeTool = async () => {
      throw new Error('network error');
    };
    registry.register(high);
    registry.register(makeToolPlugin('low', 5));
    const result: any = await registry.executeToolWithFallback('search', { query: 'test' });
    expect(result.results[0].url).toBe('https://example.com');
  });

  it('falls back when first provider returns invalid output', async () => {
    const high = makeToolPlugin('high', 20);
    high.executeTool = async () => ({ badOutput: true }); // fails output validation
    registry.register(high);
    registry.register(makeToolPlugin('low', 5)); // returns valid output
    const result: any = await registry.executeToolWithFallback('search', { query: 'test' });
    expect(result.results[0].url).toBe('https://example.com');
  });

  it('throws AggregateError when all fail', async () => {
    const p1 = makeToolPlugin('p1', 20);
    p1.executeTool = async () => {
      throw new Error('fail-1');
    };
    const p2 = makeToolPlugin('p2', 10);
    p2.executeTool = async () => {
      throw new Error('fail-2');
    };
    registry.register(p1);
    registry.register(p2);
    await expect(
      registry.executeToolWithFallback('search', { query: 'test' }),
    ).rejects.toBeInstanceOf(AggregateError);
  });

  it('throws when no candidates registered', async () => {
    await expect(registry.executeToolWithFallback('search', { query: 'test' })).rejects.toThrow(
      'No tool plugins registered',
    );
  });
});

describe('PluginRegistry — service discovery', () => {
  let registry: PluginRegistry;
  beforeEach(() => {
    registry = new PluginRegistry();
  });

  it('registerService + getService roundtrip', () => {
    const service = { hello: 'world' };
    registry.registerService('test', service);
    expect(registry.getService('test')).toBe(service);
  });

  it('registerService is idempotent (returns existing)', () => {
    const first = { a: 1 };
    const second = { b: 2 };
    const result1 = registry.registerService('svc', first);
    const result2 = registry.registerService('svc', second);
    expect(result1).toBe(first);
    expect(result2).toBe(first); // returns existing, ignores second
    expect(registry.getService('svc')).toBe(first);
  });

  it('getService returns undefined for unknown', () => {
    expect(registry.getService('nope')).toBeUndefined();
  });

  it('destroyAll clears service providers', async () => {
    registry.registerService('test', { a: 1 });
    expect(registry.getService('test')).toBeDefined();
    await registry.destroyAll();
    expect(registry.getService('test')).toBeUndefined();
  });
});

describe('PluginRegistry — initializeAll with ServiceCapabilities', () => {
  let registry: PluginRegistry;
  beforeEach(() => {
    registry = new PluginRegistry();
  });

  it('throws when plugin requires capabilities but none provided', async () => {
    const plugin = makeToolPlugin('needs-caps', 10);
    plugin.requiredCapabilities = ['db', 'config'];
    registry.register(plugin);
    await expect(
      registry.initializeAll({ logger: console as any, pluginConfig: {} }),
    ).rejects.toThrow(/requires capabilities.*db.*config.*but none were provided/);
  });

  it('throws when plugin requires capabilities not in provided set', async () => {
    const plugin = makeToolPlugin('needs-caps', 10);
    plugin.requiredCapabilities = ['db', 'callLlm'];
    registry.register(plugin);
    await expect(
      registry.initializeAll({ logger: console as any, pluginConfig: {} }, {
        db: {} as any,
      } as any),
    ).rejects.toThrow(/callLlm.*not provided/);
  });

  it('passes only requested capabilities to plugin initialize', async () => {
    const receivedCaps: any[] = [];
    const plugin: ToolPlugin = {
      ...makeToolPlugin('cap-test', 10),
      requiredCapabilities: ['db'],
      async initialize(_ctx: any, caps?: any) {
        receivedCaps.push(caps);
      },
    };
    registry.register(plugin);
    await registry.initializeAll({ logger: console as any, pluginConfig: {} }, {
      db: { marker: true } as any,
      config: { other: true } as any,
    } as any);
    expect(receivedCaps[0]).toEqual({ db: { marker: true } });
    expect(receivedCaps[0].config).toBeUndefined();
  });

  it('initializes plugins without requiredCapabilities normally', async () => {
    const plugin = makeToolPlugin('no-caps', 10);
    let initialized = false;
    plugin.initialize = async () => {
      initialized = true;
    };
    registry.register(plugin);
    await registry.initializeAll({ logger: console as any, pluginConfig: {} });
    expect(initialized).toBe(true);
  });
});
