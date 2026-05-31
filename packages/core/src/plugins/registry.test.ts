import { describe, expect, it, vi } from 'vitest';
import { PluginRegistry } from './registry';
import type { CollectorPlugin } from './types';

describe('PluginRegistry per-plugin timeout', () => {
  it('uses plugin getCollectTimeoutMs over global default when implemented', async () => {
    const slowCollector: CollectorPlugin = {
      name: 'slow',
      version: '1.0.0',
      type: 'collector',
      description: 'test fixture',
      priority: 100,
      canHandle: () => true,
      collect: vi.fn(async (_input, signal) => {
        // hang past 50ms global timeout but within 200ms plugin timeout
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (signal.aborted) throw new Error('aborted');
        return {
          content: 'ok',
          title: 't',
          metadata: {},
          finalUrl: 'https://example.com',
        };
      }),
      getCollectTimeoutMs: () => 200,
    };
    const registry = new PluginRegistry({ collectTimeoutSeconds: 0.05 }); // 50ms global
    registry.register(slowCollector);
    const handle = await registry.getCollector('https://example.com');
    expect(handle).toBeDefined();
    const result = await handle?.collect();
    expect(result?.content).toBe('ok');
  });

  it('falls back to global timeout when plugin does not implement method', async () => {
    const fastCollector: CollectorPlugin = {
      name: 'fast',
      version: '1.0.0',
      type: 'collector',
      description: 'test fixture',
      priority: 100,
      canHandle: () => true,
      collect: vi.fn(async (_input, signal) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (signal.aborted) throw new Error('global timeout aborted');
        return {
          content: 'ok',
          title: 't',
          metadata: {},
          finalUrl: 'https://example.com',
        };
      }),
    };
    const registry = new PluginRegistry({ collectTimeoutSeconds: 0.05 });
    registry.register(fastCollector);
    const handle = await registry.getCollector('https://example.com');
    await expect(handle?.collect()).rejects.toThrow();
  });
});
