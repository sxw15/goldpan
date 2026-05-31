import { describe, expect, it, vi } from 'vitest';
import { PluginRegistry } from '../../src/plugins/registry';
import type { IntentPlugin, PluginContext } from '../../src/plugins/types';

function fakePlugin(
  name: string,
  order: string[],
  opts: { postInit?: boolean } = {},
): IntentPlugin {
  const plugin: IntentPlugin = {
    name,
    version: '0.0.1',
    type: 'intent',
    description: 'test',
    intents: [{ name: `${name}_intent`, description: 'x' }],
    async initialize(_ctx) {
      order.push(`init:${name}`);
    },
    async execute() {
      return { type: 'content', text: 'ok' };
    },
  };
  if (opts.postInit) {
    plugin.postInit = async () => {
      order.push(`post:${name}`);
    };
  }
  return plugin;
}

describe('PluginRegistry.runPostInit', () => {
  it('initializeAll does NOT automatically call postInit', async () => {
    const order: string[] = [];
    const registry = new PluginRegistry();
    registry.register(fakePlugin('a', order, { postInit: true }));
    registry.register(fakePlugin('b', order, { postInit: true }));
    await registry.initializeAll({} as PluginContext, {} as any);
    expect(order).toEqual(['init:a', 'init:b']);
  });

  it('runPostInit runs every postInit after every initialize has finished', async () => {
    const order: string[] = [];
    const registry = new PluginRegistry();
    registry.register(fakePlugin('a', order, { postInit: true }));
    registry.register(fakePlugin('b', order, { postInit: true }));
    await registry.initializeAll({} as PluginContext, {} as any);
    await registry.runPostInit({} as PluginContext, {} as any);
    expect(order).toEqual(['init:a', 'init:b', 'post:a', 'post:b']);
  });

  it('runPostInit isolates failures: one plugin failing does not stop the rest', async () => {
    const order: string[] = [];
    const registry = new PluginRegistry();
    const bad = fakePlugin('bad', order, { postInit: true });
    bad.postInit = async () => {
      order.push('post:bad');
      throw new Error('boom');
    };
    registry.register(bad);
    registry.register(fakePlugin('good', order, { postInit: true }));
    await registry.initializeAll({} as PluginContext, {} as any);
    await registry.runPostInit({} as PluginContext, {} as any);
    expect(order).toEqual(['init:bad', 'init:good', 'post:bad', 'post:good']);
  });

  it('runPostInit forwards filtered capabilities per plugin', async () => {
    const registry = new PluginRegistry();
    const plugin = fakePlugin('x', []);
    const postInit = vi.fn(async () => {});
    plugin.requiredCapabilities = ['db'];
    plugin.postInit = postInit;
    registry.register(plugin);
    const db = {} as unknown;
    await registry.initializeAll({} as PluginContext, { db } as any);
    await registry.runPostInit({} as PluginContext, { db } as any);
    expect(postInit).toHaveBeenCalledWith({}, { db });
  });
});
