import { errorMessage } from '@goldpan/core/errors';
import type {
  IntentDeclaration,
  IntentExecutionContext,
  IntentPlugin,
  IntentPluginResult,
  PluginContext,
  ServiceCallLlmFn,
  ServiceCapabilities,
} from '@goldpan/core/plugins';
import { z } from 'zod';
import { handleCreateTracking } from './create-tracking-handler.js';
import { ensureTrackingTables, resetCrashedState } from './db.js';
import type { IntentHandlerResult } from './intent-handler.js';
import { handleCheckTracking, handleManageTracking } from './intent-handler.js';
import { loadPluginPrompt } from './prompt-loader.js';
import { createScheduler } from './scheduler.js';
import { TrackingCrudService } from './service.js';
import type { TrackingService } from './types.js';

const intents: IntentDeclaration[] = [
  {
    name: 'manage_tracking',
    description: 'Create, modify, delete, enable/disable, and list tracking rules',
    descriptions: {
      zh: '创建、修改、删除、启用/禁用和列出追踪规则',
    },
    examples: [
      '帮我追踪 Claude Code 最新动态',
      '列出我的追踪任务',
      '暂停追踪 #3',
      '删除追踪规则 #5',
      'Track latest news about GPT-5',
    ],
    classificationHints: ['User wants to set up, change, or manage automatic content monitoring'],
    resultTypes: ['action', 'clarify', 'content'],
  },
  {
    name: 'check_tracking',
    description: 'View tracking status, recent results, execution history',
    descriptions: {
      zh: '查看追踪状态、最近的结果和执行历史',
    },
    examples: ['追踪情况怎么样？', '最近追踪到了什么？', 'What did tracking find recently?'],
    classificationHints: ['User wants to see results or status of existing content monitoring'],
    resultTypes: ['content'],
  },
  {
    name: 'create_tracking',
    description:
      'User wants to set up automated tracking for a topic, entity, or specific source (often in URL context)',
    descriptions: {
      zh: '用户希望对某主题、实体或具体来源建立自动追踪（通常带 URL 上下文）',
    },
    examples: [
      '追踪 Claude 的新闻',
      '关注 Anthropic 这家公司',
      '帮我盯一下这家公司',
      'Track Anthropic news',
    ],
    classificationHints: [
      '明确"追踪 / 关注 / 盯 / 持续看"关键词 → create_tracking',
      '"追踪这家公司" 出现在某条 URL 上下文中（前一轮有 sourceId） → 设 linkedSourceId',
      '不要为单次查询选 tracking ("X 怎么样" 是 query 而不是 tracking)',
      '已有追踪规则要管理（列出 / 暂停 / 删除）→ manage_tracking 而非 create_tracking',
    ],
    priority: 0,
    resultTypes: ['action', 'tracking_pending', 'clarify'],
  },
];

// Module-level state captured during initialize()
let service: TrackingService | undefined;
let callLlmFn: ServiceCallLlmFn | undefined;
let unsubscribeConfig: (() => void) | undefined;

function toPluginResult(result: IntentHandlerResult): IntentPluginResult {
  switch (result.type) {
    case 'action':
      return { type: 'action', message: result.message ?? '' };
    case 'content':
      return { type: 'content', text: result.text ?? '', format: result.format };
    case 'clarify':
      return { type: 'clarify', question: result.question ?? '' };
  }
}

export const goldpanPlugin: IntentPlugin = {
  name: 'tracking',
  version: '0.1.0',
  type: 'intent',
  description: 'Content tracking with keyword search, scheduling, and auto-submission',
  descriptions: { zh: '关键词搜索 + 定时调度 + 自动提交的内容跟踪' },
  requiredCapabilities: ['db', 'config', 'pluginRegistry', 'submitInput', 'callLlm'],
  intents,

  async initialize(
    context: PluginContext,
    capabilities?: Partial<ServiceCapabilities>,
  ): Promise<void> {
    const db = capabilities?.db;
    const pluginRegistry = capabilities?.pluginRegistry;
    const submitInput = capabilities?.submitInput;
    const callLlm = capabilities?.callLlm;
    if (!db || !pluginRegistry || !submitInput || !callLlm) {
      throw new Error(
        'tracking plugin requires db, pluginRegistry, submitInput, and callLlm capabilities',
      );
    }

    // Create tables + crash recovery
    ensureTrackingTables(db);
    resetCrashedState(db);

    // Validate plugin prompts at startup
    loadPluginPrompt('tracking_action_parser', true);
    loadPluginPrompt('tracking_action_parser', false);

    // Capture callLlm for use in execute()
    callLlmFn = callLlm;

    // Plugin-specific env vars with validation. Re-evaluated on every read so a
    // `configStore.commit({ GOLDPAN_TRACKING_* })` updates the next scheduler
    // tick / next createInterest decision without a restart. All four keys are
    // whitelisted in MANAGED_ENV_KEYS, so commit() syncs them to process.env;
    // the per-tick read here observes the new value on the next decision.
    const envSchema = z.object({
      pollInterval: z.coerce.number().int().positive().default(60),
      minRuleInterval: z.coerce.number().int().positive().default(60),
      dailySearchLimit: z.coerce.number().int().positive().default(100),
      maxResultsPerSearch: z.coerce.number().int().positive().default(10),
    });

    function readSchedulerEnv() {
      return envSchema.parse({
        pollInterval: process.env.GOLDPAN_TRACKING_POLL_INTERVAL ?? undefined,
        minRuleInterval: process.env.GOLDPAN_TRACKING_MIN_RULE_INTERVAL ?? undefined,
        dailySearchLimit: process.env.GOLDPAN_TRACKING_DAILY_SEARCH_LIMIT ?? undefined,
        maxResultsPerSearch: process.env.GOLDPAN_TRACKING_MAX_RESULTS_PER_SEARCH ?? undefined,
      });
    }

    const scheduler = createScheduler({
      db,
      pluginRegistry,
      submitInput,
      getRuntimeConfig: () => {
        const parsed = readSchedulerEnv();
        return {
          pollIntervalMs: parsed.pollInterval * 1000,
          dailySearchLimit: parsed.dailySearchLimit,
          maxResultsPerSearch: parsed.maxResultsPerSearch,
        };
      },
    });

    service = new TrackingCrudService({
      db,
      pluginRegistry,
      scheduler,
      getMinRuleIntervalMinutes: () => readSchedulerEnv().minRuleInterval,
    });

    pluginRegistry.registerService<TrackingService>('tracking', service);

    // Subscribe to ConfigStore changes so config updates are visible in logs;
    // the scheduler / service already pull fresh values on every decision via
    // the getters above, so this listener is observability-only. Detached in
    // destroy() below to keep unit tests from leaking listeners.
    const previousConfig = readSchedulerEnv();
    let lastLoggedConfig = previousConfig;
    unsubscribeConfig = context.configStore.onChange(() => {
      const next = readSchedulerEnv();
      if (
        next.pollInterval !== lastLoggedConfig.pollInterval ||
        next.dailySearchLimit !== lastLoggedConfig.dailySearchLimit ||
        next.minRuleInterval !== lastLoggedConfig.minRuleInterval ||
        next.maxResultsPerSearch !== lastLoggedConfig.maxResultsPerSearch
      ) {
        context.logger.info('tracking config changed; next tick will use new values', {
          pollInterval: next.pollInterval,
          dailySearchLimit: next.dailySearchLimit,
          minRuleInterval: next.minRuleInterval,
          maxResultsPerSearch: next.maxResultsPerSearch,
        });
        lastLoggedConfig = next;
      }
    });
  },

  async postInit(
    context: PluginContext,
    capabilities?: Partial<ServiceCapabilities>,
  ): Promise<void> {
    if (!service) return;
    const db = capabilities?.db;
    if (!db) return;

    // Build SqliteMetadataRepository over capabilities.db — keeps cross-plugin
    // metadata reads opt-in instead of expanding ServiceCapabilities to expose
    // a metadata repo to every plugin (策略 B in the wizard plan §Phase K).
    const { SqliteMetadataRepository } = await import('@goldpan/core/db/repositories');
    const metadataRepo = new SqliteMetadataRepository(db);

    const seedRaw = metadataRepo.get('tracking_initial_rules');
    if (!seedRaw) return;

    try {
      const rules = JSON.parse(seedRaw) as Array<{
        name?: unknown;
        searchQueries?: unknown;
        intervalMinutes?: unknown;
        toolProvider?: unknown;
      }>;
      if (!Array.isArray(rules)) {
        throw new Error('tracking_initial_rules: not an array');
      }

      // Only seed when there are no existing rules — protects a re-run of the
      // wizard mid-deployment from clobbering the user's customizations.
      // Tracking's `initialize()` does NOT auto-seed any rules (unlike digest's
      // `seedDefaultPresets`), so a fresh DB legitimately has zero rules here.
      const existing = service.getInterests();
      if (existing.length === 0) {
        for (const r of rules) {
          if (
            typeof r.name !== 'string' ||
            !Array.isArray(r.searchQueries) ||
            typeof r.intervalMinutes !== 'number'
          ) {
            context.logger.warn('tracking postInit seed: skipping malformed rule', { rule: r });
            continue;
          }
          const queries = r.searchQueries.filter((q): q is string => typeof q === 'string');
          const toolProvider = typeof r.toolProvider === 'string' ? r.toolProvider : undefined;
          try {
            service.createInterest({
              name: r.name,
              searchQueries: queries,
              intervalMinutes: r.intervalMinutes,
              ...(toolProvider ? { toolProvider } : {}),
              enabled: true,
            });
          } catch (createErr) {
            // One bad rule (validation / duplicate name / unknown tool
            // provider) shouldn't block the rest; warn and continue.
            context.logger.warn('tracking postInit seed: createInterest failed (skipping)', {
              name: r.name,
              err: errorMessage(createErr),
            });
          }
        }
      }
    } catch (e) {
      context.logger.error('tracking postInit seed failed', {
        err: errorMessage(e),
      });
    } finally {
      // Always consume the metadata key — including on parse error and on the
      // existing-rules early-out — so the seed doesn't re-run on every restart.
      metadataRepo.delete('tracking_initial_rules');
    }
  },

  async destroy(): Promise<void> {
    // Detach configStore listener first (synchronous, can't fail) so even a
    // throwing drainScheduler doesn't leak a hot listener into the next test
    // / next bootstrap.
    if (unsubscribeConfig) {
      try {
        unsubscribeConfig();
      } finally {
        unsubscribeConfig = undefined;
      }
    }
    if (service) {
      try {
        await service.drainScheduler();
      } finally {
        service = undefined;
        callLlmFn = undefined;
      }
    }
  },

  async execute(
    intent: string,
    input: string,
    context: IntentExecutionContext,
    signal?: AbortSignal,
  ): Promise<IntentPluginResult> {
    if (!service || !callLlmFn) throw new Error('Tracking plugin not initialized');

    switch (intent) {
      case 'manage_tracking': {
        const result = await handleManageTracking(input, service, callLlmFn, signal);
        return toPluginResult(result);
      }
      case 'check_tracking': {
        const result = await handleCheckTracking(service);
        return toPluginResult(result);
      }
      case 'create_tracking': {
        // P2 — 4-branch source.status switch + path B fallback. The handler
        // returns IntentPluginResult directly (not IntentHandlerResult) since
        // it produces `tracking_pending` which is a P2-only result type with
        // no IntentHandlerResult counterpart.
        return handleCreateTracking(input, service, context, callLlmFn, signal);
      }
      default:
        throw new Error(`Unknown tracking intent: ${intent}`);
    }
  },
};
