import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildContributionEnvSchema,
  isContributionRuntimeReady,
  type PluginSettingsContribution,
  resolveContribution,
  resolveLocalized,
  validateContribution,
} from '../../src/plugins/contribution';
import { PluginRegistry } from '../../src/plugins/registry';
import type { CollectorPlugin } from '../../src/plugins/types';

describe('resolveLocalized', () => {
  it('returns plain string as-is for both locales', () => {
    expect(resolveLocalized('Bot token', 'en')).toBe('Bot token');
    expect(resolveLocalized('Bot token', 'zh')).toBe('Bot token');
  });

  it('returns direct locale value when present', () => {
    expect(resolveLocalized({ en: 'API key', zh: '密钥' }, 'zh')).toBe('密钥');
    expect(resolveLocalized({ en: 'API key', zh: '密钥' }, 'en')).toBe('API key');
  });

  it('falls back to en when current locale missing', () => {
    expect(resolveLocalized({ en: 'API key' }, 'zh')).toBe('API key');
  });

  it('falls back to any available locale when reference also missing', () => {
    expect(resolveLocalized({ zh: '只有中文' }, 'en')).toBe('只有中文');
  });

  it('throws on empty string', () => {
    expect(() => resolveLocalized('', 'en')).toThrow();
  });

  it('throws when no locale has a value', () => {
    expect(() => resolveLocalized({}, 'en')).toThrow();
  });
});

describe('validateContribution', () => {
  const baseSchema = z.object({
    apiKey: z.string().min(1),
    enabled: z.boolean(),
  });

  const validContribution = {
    pluginId: 'tool-search-tavily',
    group: 'search',
    branding: { name: 'Tavily' },
    schema: baseSchema,
    fields: [
      { name: 'apiKey', kind: 'secret', envKey: 'TAVILY_API_KEY', label: 'API Key' },
      { name: 'enabled', kind: 'toggle', envKey: 'TAVILY_ENABLED', label: 'Enabled' },
    ],
  };

  it('accepts a minimal valid contribution', () => {
    const result = validateContribution(validContribution);
    expect(result.ok).toBe(true);
  });

  it('rejects when a field name is not in schema.shape', () => {
    const bad = {
      ...validContribution,
      fields: [
        { name: 'apiKey', kind: 'secret', envKey: 'TAVILY_API_KEY', label: 'API Key' },
        { name: 'ghostField', kind: 'text', envKey: 'TAVILY_GHOST', label: 'Ghost' },
      ],
    };
    const result = validateContribution(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.message).toContain('ghostField');
    }
  });

  it('rejects duplicate envKeys', () => {
    const bad = {
      ...validContribution,
      fields: [
        { name: 'apiKey', kind: 'secret', envKey: 'SAME_KEY', label: 'API Key' },
        { name: 'enabled', kind: 'toggle', envKey: 'SAME_KEY', label: 'Enabled' },
      ],
    };
    const result = validateContribution(bad);
    expect(result.ok).toBe(false);
  });

  it('rejects action.requires referencing unknown field', () => {
    const bad = {
      ...validContribution,
      actions: [
        {
          id: 'test',
          kind: 'test',
          label: 'Test',
          requires: ['nonexistent'],
        },
      ],
    };
    const result = validateContribution(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.message).toContain('nonexistent');
    }
  });

  it('rejects schema keys that have no matching field descriptor', () => {
    const bad = {
      ...validContribution,
      schema: z.object({
        apiKey: z.string().min(1),
        enabled: z.boolean(),
        hidden: z.string().min(1),
      }),
    };
    const result = validateContribution(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.message).toContain('hidden');
    }
  });

  it('rejects schema that is not a zod object', () => {
    const bad = {
      ...validContribution,
      schema: { notReallyZod: true },
    };
    const result = validateContribution(bad);
    expect(result.ok).toBe(false);
  });

  it('rejects schema-shaped objects that are not real zod objects', () => {
    const bad = {
      ...validContribution,
      schema: { shape: { apiKey: z.string(), enabled: z.boolean() } },
    };
    const result = validateContribution(bad);
    expect(result.ok).toBe(false);
  });

  it('rejects enable envKey colliding with a field envKey', () => {
    const bad = {
      ...validContribution,
      enable: {
        envKey: 'TAVILY_ENABLED',
        label: 'Enable Tavily',
        default: false,
      },
    };
    const result = validateContribution(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.message).toContain('duplicate envKey');
    }
  });

  it('rejects duplicate action ids', () => {
    const bad = {
      ...validContribution,
      actions: [
        { id: 'test', kind: 'test', label: 'Test A' },
        { id: 'test', kind: 'test', label: 'Test B' },
      ],
    };
    const result = validateContribution(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.message).toContain('duplicate action id');
    }
  });

  it('accepts contribution with no actions and no setupGuide', () => {
    expect(validateContribution(validContribution).ok).toBe(true);
  });

  it('passes branding.homepage through unchanged when present', () => {
    const candidate = {
      ...validContribution,
      branding: { name: 'Tavily', homepage: 'https://example.com/plugin' },
    };
    const result = validateContribution(candidate);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const resolved = resolveContribution(result.contribution, 'en');
      expect(resolved.branding.homepage).toBe('https://example.com/plugin');
    }
  });

  it('rejects non-URL homepage', () => {
    const result = validateContribution({
      ...validContribution,
      branding: { name: 'Tavily', homepage: 'not-a-url' },
    });
    expect(result.ok).toBe(false);
  });

  it('accepts single-language plugin (string LocalizedString)', () => {
    const result = validateContribution({
      ...validContribution,
      branding: { name: 'Just English' },
      fields: [
        {
          name: 'apiKey',
          kind: 'secret',
          envKey: 'TAVILY_API_KEY',
          label: 'API Key',
        },
        {
          name: 'enabled',
          kind: 'toggle',
          envKey: 'TAVILY_ENABLED',
          label: { zh: '启用' },
        },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe('resolveContribution', () => {
  const contribution: PluginSettingsContribution = {
    pluginId: 'demo',
    group: 'search',
    branding: { name: { en: 'Demo', zh: '演示' } },
    schema: z.object({
      apiKey: z.string(),
      mode: z.enum(['quick', 'deep']),
    }),
    fields: [
      {
        name: 'apiKey',
        kind: 'secret',
        envKey: 'DEMO_KEY',
        label: { en: 'API Key', zh: '密钥' },
        placeholder: 'sk-...',
      },
      {
        name: 'mode',
        kind: 'segmented',
        envKey: 'DEMO_MODE',
        label: { en: 'Mode', zh: '模式' },
        options: [
          { value: 'quick', label: { en: 'Quick', zh: '快速' } },
          { value: 'deep', label: { en: 'Deep', zh: '深度' } },
        ],
        default: 'quick',
      },
    ],
    actions: [
      {
        id: 'test',
        kind: 'test',
        label: { en: 'Test', zh: '测试' },
        errorMessages: {
          unauthorized: { en: 'Bad key', zh: '密钥错误' },
        },
      },
    ],
  };

  it('flattens every LocalizedString to plain string for the requested locale', () => {
    const resolved = resolveContribution(contribution, 'zh');
    expect(resolved.branding.name).toBe('演示');
    expect(resolved.fields[0]?.label).toBe('密钥');
    expect(resolved.fields[0]?.placeholder).toBe('sk-...');
    expect(resolved.fields[1]?.options?.[0]?.label).toBe('快速');
    expect(resolved.actions?.[0]?.label).toBe('测试');
    expect(resolved.actions?.[0]?.errorMessages?.unauthorized).toBe('密钥错误');
  });

  it('uses en when zh is requested but missing', () => {
    const partial: PluginSettingsContribution = {
      ...contribution,
      branding: { name: { en: 'EN only' } },
    };
    const resolved = resolveContribution(partial, 'zh');
    expect(resolved.branding.name).toBe('EN only');
  });
});

describe('buildContributionEnvSchema', () => {
  it('validates env strings with contribution field schema semantics', () => {
    const contribution: PluginSettingsContribution = {
      pluginId: 'google',
      group: 'search',
      branding: { name: 'Google' },
      enable: {
        envKey: 'GOOGLE_ENABLED',
        label: 'Enable Google',
        default: false,
      },
      schema: z.object({
        hourlyLimit: z.number().int().min(1).max(1000).optional(),
        mode: z.enum(['quick', 'deep']).optional(),
      }),
      fields: [
        {
          name: 'hourlyLimit',
          kind: 'number',
          envKey: 'GOOGLE_HOURLY_LIMIT',
          label: 'Hourly limit',
        },
        {
          name: 'mode',
          kind: 'segmented',
          envKey: 'GOOGLE_MODE',
          label: 'Mode',
          options: [
            { value: 'quick', label: 'Quick' },
            { value: 'deep', label: 'Deep' },
          ],
        },
      ],
    };

    const schema = z.object(buildContributionEnvSchema(contribution));
    expect(
      schema.safeParse({
        GOOGLE_ENABLED: 'true',
        GOOGLE_HOURLY_LIMIT: '20',
        GOOGLE_MODE: 'deep',
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ GOOGLE_HOURLY_LIMIT: '0' }).success).toBe(false);
    expect(schema.safeParse({ GOOGLE_HOURLY_LIMIT: 'abc' }).success).toBe(false);
    expect(schema.safeParse({ GOOGLE_MODE: 'invalid' }).success).toBe(false);
    expect(schema.safeParse({ GOOGLE_ENABLED: 'yes' }).success).toBe(false);
  });
});

describe('isContributionRuntimeReady', () => {
  const withEnable: PluginSettingsContribution = {
    pluginId: 'tool-search-tavily',
    group: 'search',
    branding: { name: 'Tavily' },
    enable: {
      envKey: 'GOLDPAN_TAVILY_SEARCH_ENABLED',
      label: 'Enable',
      default: false,
    },
    schema: z.object({ apiKey: z.string().optional() }),
    fields: [{ name: 'apiKey', kind: 'secret', envKey: 'TAVILY_API_KEY', label: 'API Key' }],
  };

  const secretOnly: PluginSettingsContribution = {
    pluginId: 'no-enable',
    group: 'search',
    branding: { name: 'NoEnable' },
    schema: z.object({ apiKey: z.string().optional() }),
    fields: [{ name: 'apiKey', kind: 'secret', envKey: 'NO_ENABLE_KEY', label: 'API Key' }],
  };

  it('returns true when enable=true and all secrets are non-empty', () => {
    expect(
      isContributionRuntimeReady(withEnable, {
        GOLDPAN_TAVILY_SEARCH_ENABLED: 'true',
        TAVILY_API_KEY: 'tvly-abc',
      }),
    ).toBe(true);
  });

  it('returns false when enable is declared but env is missing or not "true"', () => {
    expect(isContributionRuntimeReady(withEnable, { TAVILY_API_KEY: 'tvly-abc' })).toBe(false);
    expect(
      isContributionRuntimeReady(withEnable, {
        GOLDPAN_TAVILY_SEARCH_ENABLED: 'false',
        TAVILY_API_KEY: 'tvly-abc',
      }),
    ).toBe(false);
    // The literal string match is intentional: only "true" enables, anything
    // else (truthy-ish like "1" or "yes") leaves the plugin off, matching how
    // each plugin's executeTool gates itself.
    expect(
      isContributionRuntimeReady(withEnable, {
        GOLDPAN_TAVILY_SEARCH_ENABLED: '1',
        TAVILY_API_KEY: 'tvly-abc',
      }),
    ).toBe(false);
  });

  it('returns false when enable is on but a secret is missing or empty', () => {
    expect(isContributionRuntimeReady(withEnable, { GOLDPAN_TAVILY_SEARCH_ENABLED: 'true' })).toBe(
      false,
    );
    expect(
      isContributionRuntimeReady(withEnable, {
        GOLDPAN_TAVILY_SEARCH_ENABLED: 'true',
        TAVILY_API_KEY: '',
      }),
    ).toBe(false);
  });

  it('skips enable check when contribution has no enable block', () => {
    expect(isContributionRuntimeReady(secretOnly, { NO_ENABLE_KEY: 'k' })).toBe(true);
    expect(isContributionRuntimeReady(secretOnly, {})).toBe(false);
  });

  it('ignores optional non-secret fields (configuration vs credentials)', () => {
    const config: PluginSettingsContribution = {
      pluginId: 'cfg-only',
      group: 'search',
      branding: { name: 'CfgOnly' },
      schema: z.object({ hourlyLimit: z.number().int().optional() }),
      fields: [{ name: 'hourlyLimit', kind: 'number', envKey: 'CFG_HOURLY_LIMIT', label: 'Limit' }],
    };
    // No secrets to check and no enable block → always ready, even with empty env.
    expect(isContributionRuntimeReady(config, {})).toBe(true);
  });

  it('requires non-secret fields explicitly marked required', () => {
    const config: PluginSettingsContribution = {
      pluginId: 'searxng-like',
      group: 'search',
      branding: { name: 'SearXNG-like' },
      enable: { envKey: 'SEARCH_ENABLED', label: 'Enable', default: false },
      schema: z.object({ baseUrl: z.string().optional() }),
      fields: [
        {
          name: 'baseUrl',
          kind: 'text',
          envKey: 'SEARCH_BASE_URL',
          label: 'Base URL',
          required: true,
        },
      ],
    };

    expect(isContributionRuntimeReady(config, { SEARCH_ENABLED: 'true' })).toBe(false);
    expect(
      isContributionRuntimeReady(config, { SEARCH_ENABLED: 'true', SEARCH_BASE_URL: '   ' }),
    ).toBe(false);
    expect(
      isContributionRuntimeReady(config, {
        SEARCH_ENABLED: 'true',
        SEARCH_BASE_URL: 'https://search.example.com',
      }),
    ).toBe(true);
  });
});

describe('PluginRegistry auto-registers settings contribution from plugin', () => {
  function makePluginWithContribution(): CollectorPlugin {
    return {
      name: 'demo-collector',
      version: '1.0.0',
      type: 'collector',
      description: 'Demo',
      priority: 0,
      canHandle: () => true,
      collect: async () => ({
        content: '',
        title: null,
        metadata: {},
        finalUrl: 'https://example.com',
      }),
      settingsContribution: {
        pluginId: 'demo-collector',
        group: 'collect',
        branding: { name: 'Demo Collector' },
        schema: z.object({ enabled: z.boolean() }),
        fields: [
          {
            name: 'enabled',
            kind: 'toggle',
            envKey: 'DEMO_ENABLED',
            label: 'Enabled',
            default: false,
          },
        ],
      },
    };
  }

  it('registers contribution alongside collector when plugin declares one', () => {
    const registry = new PluginRegistry();
    registry.register(makePluginWithContribution());
    expect(registry.getSettingsContribution('demo-collector')).toBeDefined();
    expect(registry.getSettingsContributions()).toHaveLength(1);
  });

  it('threads version + locale-resolved description from the parent plugin into the descriptor', async () => {
    // Regression coverage for the contribution descriptor build path:
    // PluginRegistry.register must capture `plugin.version` and a `plugin`
    // reference on the registration so the contributions route can call
    // `resolvePluginDescription(plugin, locale)` instead of open-coding the
    // descriptions[locale] ?? description fallback. If anyone re-introduces
    // duplicated fallback logic in the route, this test catches the missing
    // wiring at the registry layer.
    const { resolvePluginDescription } = await import('../../src/plugins/types');
    const registry = new PluginRegistry();
    const plugin: CollectorPlugin = {
      ...makePluginWithContribution(),
      version: '1.2.3',
      description: 'EN desc',
      descriptions: { zh: 'ZH 描述' },
    };
    registry.register(plugin);

    const registration = registry.getSettingsContribution('demo-collector');
    expect(registration).toBeDefined();
    if (registration === undefined) return;

    // Version is threaded verbatim.
    expect(registration.pluginVersion).toBe('1.2.3');

    // Description is threaded as a `plugin` reference (the subset needed by
    // resolvePluginDescription), NOT as a pre-resolved string. The route
    // resolves per-locale at request time — exercise both locales here.
    expect(registration.plugin).toBeDefined();
    if (registration.plugin === undefined) return;
    expect(resolvePluginDescription(registration.plugin, 'en')).toBe('EN desc');
    expect(resolvePluginDescription(registration.plugin, 'zh')).toBe('ZH 描述');
  });

  it('omits the plugin reference for direct registerSettingsContribution callers (IM channels / tests)', () => {
    // IM channels register contributions without a `GoldpanPlugin` parent —
    // they have manifest-derived contributions only. The descriptor build
    // must not crash on a missing plugin reference; the meta strip simply
    // renders without a description column in that case.
    const registry = new PluginRegistry();
    registry.registerSettingsContribution(
      {
        pluginId: 'manifest-only',
        group: 'collect',
        branding: { name: 'Manifest Only' },
        schema: z.object({ enabled: z.boolean() }),
        fields: [
          {
            name: 'enabled',
            kind: 'toggle',
            envKey: 'MANIFEST_ENABLED',
            label: 'Enabled',
            default: false,
          },
        ],
      },
      undefined,
      { pluginVersion: '0.5.0' },
    );

    const registration = registry.getSettingsContribution('manifest-only');
    expect(registration?.pluginVersion).toBe('0.5.0');
    expect(registration?.plugin).toBeUndefined();
  });

  it('rejects pluginId mismatch with plugin.name', () => {
    const registry = new PluginRegistry();
    const plugin = makePluginWithContribution();
    plugin.settingsContribution = {
      ...plugin.settingsContribution!,
      pluginId: 'wrong-id',
    };
    expect(() => registry.register(plugin)).toThrow(/pluginId.*must match plugin\.name/);
  });

  it('rejects action without handler', () => {
    const registry = new PluginRegistry();
    const plugin = makePluginWithContribution();
    plugin.settingsContribution = {
      ...plugin.settingsContribution!,
      actions: [{ id: 'test', kind: 'test', label: 'Test' }],
    };
    // No settingsActionHandlers provided
    expect(() => registry.register(plugin)).toThrow(/no handler is provided/);
  });

  it('does not leave a typed plugin registered when contribution registration fails', () => {
    const registry = new PluginRegistry();
    const plugin = makePluginWithContribution();
    plugin.settingsContribution = {
      ...plugin.settingsContribution!,
      actions: [{ id: 'test', kind: 'test', label: 'Test' }],
    };

    expect(() => registry.register(plugin)).toThrow(/no handler is provided/);
    expect(registry.hasPlugin('demo-collector')).toBe(false);
    expect(registry.getSettingsContribution('demo-collector')).toBeUndefined();
  });

  it('records settings contribution asset directory when provided by the host', () => {
    const registry = new PluginRegistry();
    registry.register(makePluginWithContribution(), {
      settingsAssetDir: '/tmp/demo-collector/static',
    });

    expect(registry.getSettingsContribution('demo-collector')?.assetDir).toBe(
      '/tmp/demo-collector/static',
    );
  });
});
