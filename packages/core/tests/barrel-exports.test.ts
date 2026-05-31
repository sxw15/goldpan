import { describe, expect, it } from 'vitest';

describe('barrel exports', () => {
  it('root barrel exports public API', async () => {
    const core = await import('../src/index.js');
    // Config
    expect(core.loadConfig).toBeTypeOf('function');
    // Logger
    expect(core.createRootLogger).toBeTypeOf('function');
    expect(core.createSubLogger).toBeTypeOf('function');
    // DB
    expect(core.createDatabase).toBeTypeOf('function');
    expect(core.getRawDatabase).toBeTypeOf('function');
    // Repositories
    expect(core.SqliteCategoryRepository).toBeTypeOf('function');
    expect(core.SqliteKnowledgeRepository).toBeTypeOf('function');
    expect(core.SqliteSourceRepository).toBeTypeOf('function');
    expect(core.SqliteTaskRepository).toBeTypeOf('function');
    expect(core.SqliteEventLogRepository).toBeTypeOf('function');
    expect(core.SqliteSubmissionLogRepository).toBeTypeOf('function');
    // Utils
    expect(core.normalizeUrl).toBeTypeOf('function');
    expect(core.validateSsrf).toBeTypeOf('function');
    expect(core.validateSsrfIfEnabled).toBeTypeOf('function');
    expect(core.isPrivateIp).toBeTypeOf('function');
    expect(core.detectInputUrl).toBeTypeOf('function');
    // LLM (Phase 2)
    expect(core.createLlmRegistry).toBeTypeOf('function');
    expect(core.callLlm).toBeTypeOf('function');
    expect(core.TIER_TO_PROVIDER_OPTIONS).toBeTypeOf('object');
    expect(core.REASONING_TIERS).toBeInstanceOf(Array);
    expect(core.inferTierFromOptions).toBeTypeOf('function');
    // Intent
    expect(core.createIntentSchema).toBeTypeOf('function');
    expect(core.classifyIntent).toBeTypeOf('function');
    expect(core.PipelineError).toBeTypeOf('function');
    // Prompts (Phase 2)
    expect(core.loadPromptTemplate).toBeTypeOf('function');
    expect(core.compilePrompt).toBeTypeOf('function');
    expect(core.computePromptHash).toBeTypeOf('function');
    // LlmCallRepository (Phase 2)
    expect(core.SqliteLlmCallRepository).toBeTypeOf('function');
    // Plugins
    expect(core.PluginRegistry).toBeTypeOf('function');
    expect(core.CollectorError).toBeTypeOf('function');
    expect(core.formatAbortSignalReason).toBeTypeOf('function');
    expect(core.parseCollectedHtml).toBeTypeOf('function');
    expect(core.collectorWebPlugin).toBeDefined();
    expect(core.collectorWebPlugin.name).toBe('collector-web');
  });

  it('plugin barrel exports full plugin API', async () => {
    const plugins = await import('../src/plugins/index.js');
    // Classes
    expect(plugins.PluginRegistry).toBeTypeOf('function');
    expect(plugins.CollectorError).toBeTypeOf('function');
    expect(plugins.formatAbortSignalReason).toBeTypeOf('function');
    expect(plugins.parseCollectedHtml).toBeTypeOf('function');
    // Built-in plugin
    expect(plugins.collectorWebPlugin).toBeDefined();
    expect(plugins.collectorWebPlugin.type).toBe('collector');
    expect(plugins.collectorWebPlugin.name).toBe('collector-web');
    expect(plugins.emitCollectDiagnostic).toBeTypeOf('function');
    expect(plugins.runWithCollectDiagnostics).toBeTypeOf('function');
    // Add after the existing collectorWebPlugin assertions (around line 64)
    expect(plugins.isIntentPlugin).toBeTypeOf('function');
    // Built-in intent plugins
    expect(plugins.intentSubmitPlugin).toBeDefined();
    expect(plugins.intentSubmitPlugin.type).toBe('intent');
    expect(plugins.intentSubmitPlugin.name).toBe('intent-submit');
    expect(plugins.intentQueryPlugin).toBeDefined();
    expect(plugins.intentQueryPlugin.type).toBe('intent');
    expect(plugins.intentQueryPlugin.name).toBe('intent-query');
    // getCollector adapter smoke test
    const registry = new plugins.PluginRegistry();
    registry.register(plugins.collectorWebPlugin);
    const adapter = await registry.getCollector('https://example.com');
    expect(adapter).toBeDefined();
    expect(typeof adapter?.collect).toBe('function');
  });

  it('repository barrel exports all repositories', async () => {
    const repos = await import('../src/db/repositories/index.js');
    expect(repos.SqliteCategoryRepository).toBeTypeOf('function');
    expect(repos.SqliteKnowledgeRepository).toBeTypeOf('function');
    expect(repos.SqliteEventLogRepository).toBeTypeOf('function');
    expect(repos.SqliteSourceRepository).toBeTypeOf('function');
    expect(repos.SqliteSubmissionLogRepository).toBeTypeOf('function');
    expect(repos.SqliteTaskRepository).toBeTypeOf('function');
  });
});
