import { PluginRegistry } from '@goldpan/core/plugins';
import type { ChannelAdapter, ImChannelBundle } from '@goldpan/im-runtime';
import { describe, expect, it, vi } from 'vitest';
import { type ComposeIMRuntimeHandle, composeIMRuntime } from '../src/im-compose.js';

function makeStubLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    silly: vi.fn(),
    getSubLogger: vi.fn(),
    settings: {},
  };
}

function makeHandle(): ComposeIMRuntimeHandle {
  return {
    config: {
      language: 'en',
      im: {
        conversationWindowSize: 8,
        conversationTtlDays: 30,
        dedupeTtlHours: 72,
        dedupePurgeIntervalMinutes: 60,
      },
    } as ComposeIMRuntimeHandle['config'],
    db: {} as ComposeIMRuntimeHandle['db'],
    repos: { conversation: {} } as ComposeIMRuntimeHandle['repos'],
    pluginRegistry: new PluginRegistry(),
    callLlm: vi.fn() as unknown as ComposeIMRuntimeHandle['callLlm'],
    embeddingProvider: null,
    logger: makeStubLogger() as unknown as ComposeIMRuntimeHandle['logger'],
  };
}

function makeBundle(opts: {
  channelId: string;
  enabled?: boolean;
  channelConfig?: Record<string, unknown>;
  secrets?: Record<string, string>;
}): ImChannelBundle {
  const enabled = opts.enabled ?? true;
  return {
    channelId: opts.channelId,
    module: {
      manifest: {
        channelId: opts.channelId,
        branding: { name: { en: opts.channelId, zh: opts.channelId } },
        enable: {
          envKey: `GOLDPAN_IM_${opts.channelId.toUpperCase()}_ENABLED`,
          label: { en: 'on', zh: '开' },
          default: true,
        },
        fields: [],
        actions: [],
        setupGuide: { allDoneTitle: { en: 'D', zh: '完' }, steps: [] },
      },
      handlers: {},
    },
    envSpec: {
      channelId: opts.channelId,
      envSchema: {},
      parse: () => ({ enabled }),
      toValues: () => ({}),
    },
    registration: () =>
      enabled
        ? {
            adapter: { channelId: opts.channelId } as ChannelAdapter,
            channelConfig: opts.channelConfig ?? {},
            secrets: opts.secrets ?? {},
          }
        : null,
    staticDir: `/tmp/${opts.channelId}`,
  };
}

function makeFakeRuntimeCtor() {
  const register = vi.fn();
  const start = vi.fn(async () => {});
  class FakeRuntime {
    register = register;
    start = start;
  }
  return { FakeRuntime, register, start };
}

describe('composeIMRuntime — service registration', () => {
  it('registers im_runtime service when at least one channel registers', async () => {
    const handle = makeHandle();
    const { FakeRuntime } = makeFakeRuntimeCtor();
    const { runtime } = await composeIMRuntime(handle, {
      IMRuntimeCtor: FakeRuntime,
      bundles: [makeBundle({ channelId: 'telegram' })],
      secretResolver: { resolve: () => 'tok' },
    });
    expect(runtime).not.toBeNull();
    expect(handle.pluginRegistry.getService('im_runtime')).toBe(runtime);
    expect(handle.pluginRegistry.getService('im_settings_modules')).toBeDefined();
  });

  it('returns null runtime when discovered channels all self-disable', async () => {
    const handle = makeHandle();
    const { runtime } = await composeIMRuntime(handle, {
      bundles: [makeBundle({ channelId: 'telegram', enabled: false })],
    });
    expect(runtime).toBeNull();
    expect(handle.pluginRegistry.getService('im_settings_modules')).toBeDefined();
  });

  it('returns null runtime when no channels discovered', async () => {
    const handle = makeHandle();
    const { runtime } = await composeIMRuntime(handle, { bundles: [] });
    expect(runtime).toBeNull();
  });

  it('registers all enabled bundles, skipping disabled ones', async () => {
    const handle = makeHandle();
    const { FakeRuntime, register } = makeFakeRuntimeCtor();
    await composeIMRuntime(handle, {
      IMRuntimeCtor: FakeRuntime,
      bundles: [
        makeBundle({ channelId: 'telegram' }),
        makeBundle({ channelId: 'feishu', enabled: false }),
        makeBundle({ channelId: 'demo' }),
      ],
      secretResolver: { resolve: () => 'tok' },
    });
    const channelIds = register.mock.calls.map((c) => (c[0] as ChannelAdapter).channelId);
    expect(channelIds).toEqual(['telegram', 'demo']);
  });

  it('still registers im_runtime even when start() throws', async () => {
    const handle = makeHandle();
    const register = vi.fn();
    class FakeRuntime {
      register = register;
      start = async () => {
        throw new Error('boom');
      };
    }
    const { runtime } = await composeIMRuntime(handle, {
      IMRuntimeCtor: FakeRuntime,
      bundles: [makeBundle({ channelId: 'telegram' })],
      secretResolver: { resolve: () => 'tok' },
    });
    expect(runtime).not.toBeNull();
    expect(handle.pluginRegistry.getService('im_runtime')).toBe(runtime);
  });
});
