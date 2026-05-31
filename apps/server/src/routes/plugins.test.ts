import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { buildPluginsSnapshot, type PluginInfo } from './plugins.js';

function mockPlugin(
  overrides: Partial<{
    name: string;
    version: string;
    description: string;
    type: string;
    settingsContribution: unknown;
  }>,
) {
  return {
    name: 'plugin',
    version: '0.1.0',
    description: 'desc',
    type: 'collector',
    priority: 0,
    canHandle: () => false,
    collect: async () => ({ content: '', title: null, metadata: {}, finalUrl: '' }),
    ...overrides,
  };
}

function makeRegistry(opts: {
  collectors?: unknown[];
  intentPlugins?: unknown[];
  toolPlugins?: unknown[];
  llmProviderPlugins?: unknown[];
  llmProviderLoadStatus?: Record<
    string,
    { status: 'loaded' | 'failed' | 'skipped_conflict'; error?: string }
  >;
}) {
  return {
    getCollectors: () => opts.collectors ?? [],
    getIntentPlugins: () => opts.intentPlugins ?? [],
    getToolPlugins: () => opts.toolPlugins ?? [],
    getLlmProviderPlugins: () => opts.llmProviderPlugins ?? [],
    getLlmProviderLoadStatus: () => opts.llmProviderLoadStatus ?? {},
  } as unknown as Parameters<typeof buildPluginsSnapshot>[0];
}

describe('buildPluginsSnapshot', () => {
  test('过滤内置 plugin (intent-submit / intent-query / collector-web)', () => {
    const reg = makeRegistry({
      collectors: [
        mockPlugin({ name: 'collector-web', type: 'collector' }),
        mockPlugin({ name: 'collector-browser', type: 'collector' }),
      ],
      intentPlugins: [
        mockPlugin({ name: 'intent-submit', type: 'intent' }),
        mockPlugin({ name: 'intent-query', type: 'intent' }),
        mockPlugin({ name: 'tracking', type: 'intent' }),
      ],
    });
    const snap = buildPluginsSnapshot(reg);
    const names = snap.plugins.map((p: PluginInfo) => p.name);
    expect(names).not.toContain('collector-web');
    expect(names).not.toContain('intent-submit');
    expect(names).not.toContain('intent-query');
    expect(names).toContain('collector-browser');
    expect(names).toContain('tracking');
  });

  test('envKeys 来自 plugin.settingsContribution.fields[].envKey (configured 反映 process.env)', () => {
    const original = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = 'tvly-xxx';
    try {
      const reg = makeRegistry({
        toolPlugins: [
          mockPlugin({
            name: 'tool-search-tavily',
            version: '1.2.3',
            description: 'Tavily search',
            type: 'tool',
            settingsContribution: {
              pluginId: 'tool-search-tavily',
              group: 'search',
              branding: { name: 'Tavily' },
              schema: z.object({ apiKey: z.string().min(1) }),
              fields: [
                {
                  name: 'apiKey',
                  kind: 'secret',
                  envKey: 'TAVILY_API_KEY',
                  label: 'API Key',
                },
              ],
            },
          }),
        ],
      });
      const snap = buildPluginsSnapshot(reg);
      const tav = snap.plugins.find((p: PluginInfo) => p.name === 'tool-search-tavily');
      expect(tav).toBeDefined();
      expect(tav?.displayName).toBe('tool-search-tavily');
      expect(tav?.version).toBe('1.2.3');
      expect(tav?.type).toBe('tool');
      expect(tav?.status).toBe('loaded');
      expect(tav?.envKeys).toEqual([{ key: 'TAVILY_API_KEY', configured: true }]);
      expect(tav?.configGroup).toBe('search');
    } finally {
      if (original === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = original;
    }
  });

  test('envKey 未在 process.env 配置时 configured=false', () => {
    const original = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    try {
      const reg = makeRegistry({
        toolPlugins: [
          mockPlugin({
            name: 'tool-search-tavily',
            type: 'tool',
            settingsContribution: {
              pluginId: 'tool-search-tavily',
              group: 'search',
              branding: { name: 'Tavily' },
              schema: z.object({ apiKey: z.string().min(1) }),
              fields: [
                {
                  name: 'apiKey',
                  kind: 'secret',
                  envKey: 'TAVILY_API_KEY',
                  label: 'API Key',
                },
              ],
            },
          }),
        ],
      });
      const snap = buildPluginsSnapshot(reg);
      const tav = snap.plugins.find((p: PluginInfo) => p.name === 'tool-search-tavily');
      expect(tav?.envKeys).toEqual([{ key: 'TAVILY_API_KEY', configured: false }]);
    } finally {
      if (original !== undefined) process.env.TAVILY_API_KEY = original;
    }
  });

  test('没有 settingsContribution 的 plugin 返回 envKeys=[]', () => {
    const reg = makeRegistry({
      collectors: [mockPlugin({ name: 'unknown-plugin', type: 'collector' })],
    });
    const snap = buildPluginsSnapshot(reg);
    const p = snap.plugins.find((x: PluginInfo) => x.name === 'unknown-plugin');
    expect(p?.envKeys).toEqual([]);
  });

  test('PLUGIN_CONFIG_GROUP_MAP 未登记的 plugin configGroup=undefined', () => {
    const reg = makeRegistry({
      collectors: [
        mockPlugin({
          name: 'unknown-plugin',
          type: 'collector',
          settingsContribution: {
            pluginId: 'unknown-plugin',
            group: 'collect',
            branding: { name: 'Unknown' },
            schema: z.object({}),
            fields: [],
          },
        }),
      ],
    });
    const snap = buildPluginsSnapshot(reg);
    const p = snap.plugins.find((x: PluginInfo) => x.name === 'unknown-plugin');
    expect(p?.configGroup).toBeUndefined();
  });

  test('settingsContribution.enable.envKey 也进 envKeys 列表 (digest pattern)', () => {
    const originalEnabled = process.env.GOLDPAN_DIGEST_ENABLED;
    const originalTime = process.env.GOLDPAN_DIGEST_DAILY_TIME;
    process.env.GOLDPAN_DIGEST_ENABLED = 'true';
    delete process.env.GOLDPAN_DIGEST_DAILY_TIME;
    try {
      const reg = makeRegistry({
        intentPlugins: [
          mockPlugin({
            name: 'digest',
            type: 'intent',
            settingsContribution: {
              pluginId: 'digest',
              group: 'digest',
              branding: { name: 'Digest' },
              enable: {
                envKey: 'GOLDPAN_DIGEST_ENABLED',
                label: 'Enable digest',
                default: false,
              },
              schema: z.object({ dailyTime: z.string() }),
              fields: [
                {
                  name: 'dailyTime',
                  kind: 'text',
                  envKey: 'GOLDPAN_DIGEST_DAILY_TIME',
                  label: 'Daily time',
                },
              ],
            },
          }),
        ],
      });
      const snap = buildPluginsSnapshot(reg);
      const dig = snap.plugins.find((p: PluginInfo) => p.name === 'digest');
      expect(dig?.envKeys).toEqual([
        { key: 'GOLDPAN_DIGEST_ENABLED', configured: true },
        { key: 'GOLDPAN_DIGEST_DAILY_TIME', configured: false },
      ]);
      expect(dig?.configGroup).toBe('digest');
    } finally {
      if (originalEnabled === undefined) delete process.env.GOLDPAN_DIGEST_ENABLED;
      else process.env.GOLDPAN_DIGEST_ENABLED = originalEnabled;
      if (originalTime !== undefined) process.env.GOLDPAN_DIGEST_DAILY_TIME = originalTime;
    }
  });

  test('llm-provider plugin 走 getLlmProviderLoadStatus', () => {
    const reg = makeRegistry({
      llmProviderPlugins: [
        {
          ...mockPlugin({ name: '@goldpan/plugin-llm-cohere', type: 'llm-provider' }),
          providerId: 'cohere',
        },
      ],
      llmProviderLoadStatus: {
        '@goldpan/plugin-llm-cohere': { status: 'failed', error: 'API key missing' },
      },
    });
    const snap = buildPluginsSnapshot(reg);
    const p = snap.plugins.find((x: PluginInfo) => x.type === 'llm-provider');
    expect(p?.status).toBe('failed');
    expect(p?.error).toBe('API key missing');
  });

  test('registryInstallSupported 永远 false', () => {
    const snap = buildPluginsSnapshot(makeRegistry({}));
    expect(snap.registryInstallSupported).toBe(false);
  });

  test('locale=zh 选 descriptions.zh，缺则 fallback 到 description', () => {
    const reg = makeRegistry({
      collectors: [
        {
          ...mockPlugin({
            name: 'collector-browser',
            description: 'Browser-based collector',
            type: 'collector',
          }),
          descriptions: { zh: '基于浏览器的内容采集' },
        },
        mockPlugin({
          name: 'collector-media',
          description: 'video collector',
          type: 'collector',
        }),
      ],
    });
    const zhSnap = buildPluginsSnapshot(reg, 'zh');
    expect(zhSnap.plugins.find((p) => p.name === 'collector-browser')?.description).toBe(
      '基于浏览器的内容采集',
    );
    // No zh override → fallback to default description.
    expect(zhSnap.plugins.find((p) => p.name === 'collector-media')?.description).toBe(
      'video collector',
    );
    // Default (en) keeps the original description.
    const enSnap = buildPluginsSnapshot(reg, 'en');
    expect(enSnap.plugins.find((p) => p.name === 'collector-browser')?.description).toBe(
      'Browser-based collector',
    );
  });

  test('plugins 按 type 内 name 升序排序', () => {
    const reg = makeRegistry({
      collectors: [
        mockPlugin({ name: 'collector-media', type: 'collector' }),
        mockPlugin({ name: 'collector-browser', type: 'collector' }),
      ],
    });
    const snap = buildPluginsSnapshot(reg);
    const collectorNames = snap.plugins
      .filter((p: PluginInfo) => p.type === 'collector')
      .map((p: PluginInfo) => p.name);
    expect(collectorNames).toEqual(['collector-browser', 'collector-media']);
  });

  test('LLM provider plugin 在 /settings/plugins 与 /settings/llm-providers 字段一致', async () => {
    const { buildLlmProvidersSnapshot } = await import('./llm-providers.js');
    const cohereStatus = { status: 'failed' as const, error: 'API key missing' };
    const reg = makeRegistry({
      llmProviderPlugins: [
        {
          ...mockPlugin({
            name: '@goldpan/plugin-llm-cohere',
            version: '0.3.1',
            type: 'llm-provider',
          }),
          providerId: 'cohere',
        },
      ],
      llmProviderLoadStatus: { '@goldpan/plugin-llm-cohere': cohereStatus },
    });
    const pluginsSnap = buildPluginsSnapshot(reg);
    const config = {
      customLlmProviders: [],
      providerModels: {},
      providerEmbeddingModels: {},
    } as unknown as Parameters<typeof buildLlmProvidersSnapshot>[0];
    const llmSnap = buildLlmProvidersSnapshot(config, reg as never);
    const fromPlugins = pluginsSnap.plugins.find(
      (p: PluginInfo) => p.name === '@goldpan/plugin-llm-cohere',
    );
    const fromLlm = llmSnap.plugin.find(
      (p: { pluginName: string }) => p.pluginName === '@goldpan/plugin-llm-cohere',
    );
    expect(fromPlugins?.version).toBe('0.3.1');
    expect(fromPlugins?.status).toBe('failed');
    expect(fromPlugins?.error).toBe('API key missing');
    expect(fromLlm?.status).toBe(fromPlugins?.status);
    expect(fromLlm?.error).toBe(fromPlugins?.error);
  });
});
