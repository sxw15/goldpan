import path from 'node:path';
import type { ILogObj, Logger } from 'tslog';
import type { GoldpanConfig } from './config/index';
import { resolveProjectRoot, resolveStepTimeout } from './config/index';
import { createConfigStore } from './config/store';
import type { ConfigPatch, ConfigStore, WizardCommitResult } from './config/store-types';
import type { WizardCommitOptions } from './config/wizard-commit';
import { commitWizardOverrides } from './config/wizard-commit';
import { extractAssistantTurn, finalizeBuffer, startBufferWatcher } from './conversation/index';
import { closeDatabase, createDatabase, type DrizzleDB, getRawDatabase } from './db/connection';
import { ensureFtsTables } from './db/fts';
import { resolveMigrationsFolder, runMigrations } from './db/migrate';
import {
  SqliteCategoryRepository,
  SqliteConversationRepository,
  SqliteEventLogRepository,
  SqliteKnowledgeRepository,
  SqliteLlmCallRepository,
  SqliteMetadataRepository,
  SqliteNotesRepository,
  SqliteSourceRepository,
  SqliteSourceViewRepository,
  SqliteSubmissionLogRepository,
  SqliteTaskLogRepository,
  SqliteTaskRepository,
} from './db/repositories/index';
import { SqliteRuntimeConfigOverrideRepository } from './db/repositories/runtime-config';
import type {
  CategoryRepository,
  ConversationRepository,
  EventLogRepository,
  KnowledgeRepository,
  LlmCallRepository,
  MetadataRepository,
  SourceRepository,
  SourceViewRepository,
  SubmissionLogRepository,
  TaskLogRepository,
  TaskRepository,
} from './db/repositories/types';
import { backfillEmbeddings, ensureVecTables } from './db/vec';
import type {
  DeferredResolutionStatus,
  DeferredTrackingPort,
  ImSendOutbound,
  PendingResolutionPayload,
} from './deferred/index';
import { onSourceTerminated, startClarifyTimeoutWatcher } from './deferred/index';
import { AiSdkEmbeddingProvider } from './embedding/ai-sdk-provider';
import type { EmbeddingProvider } from './embedding/types';
import { errorMessage } from './errors';
import { initI18n, resolveLanguageLock } from './i18n/index';
import { handleInput } from './input';
import { callLlm, createLlmRegistry } from './llm/index';
import { STEP_TO_MODEL_KEY } from './llm/resolve';
import { createRootLogger, createSubLogger } from './logger/index';
import type { NotesRepository } from './notes/types';
import type { WizardReason } from './onboarding/wizard-mode';
import type { CallLlmFn, Pipeline } from './pipeline/index';
import {
  createPipeline,
  executeClassifying,
  executeCollecting,
  executeComparing,
  executeExtracting,
  executeMatching,
  executeRelating,
  executeStoring,
  executeTranslating,
  executeVerifying,
  validatePipelineOutput,
} from './pipeline/index';
import { loadExternalPlugins } from './plugins/external';
import {
  collectorWebPlugin,
  intentNotePlugin,
  intentQueryPlugin,
  intentSubmitPlugin,
  PluginRegistry,
} from './plugins/index';
import type {
  GoldpanPlugin,
  PluginContext,
  ServiceCallLlmFn,
  ServiceCapabilities,
} from './plugins/types';
import { validatePromptFiles } from './prompts/index';
import { type SubmitResult, submitInput as submitInputFn } from './submit';
import { drainAndStop, startWorker } from './worker/index';

export interface BootstrapOptions {
  /**
   * Frozen process.env snapshot taken in apps/server/main.ts after
   * dotenv.config() but before bootstrap(). Required — explicit so the
   * "when do we capture the baseline" question has a single answer.
   */
  bootEnv: Readonly<NodeJS.ProcessEnv>;
  /** Skip starting the background worker (e.g. web-only mode). Default: false */
  skipWorker?: boolean;
  /** Explicit drizzle migrations folder path. Auto-resolved if omitted. */
  migrationsFolder?: string;
  /**
   * Wizard-mode policy:
   * - 'auto' (default): try strict loadConfig + detectWizardMode; on detection
   *   trigger, switch to wizard mode automatically.
   * - 'wizard': force wizard mode, skip strict loadConfig regardless of env.
   *   Equivalent to setting `GOLDPAN_FORCE_WIZARD=true` in 'auto' mode.
   * - 'normal': skip wizard detection, fail-fast on missing config (current
   *   `loadConfig()` behavior). Use for one-shot CLI submit, tests that
   *   want strict building behavior, etc.
   */
  mode?: 'auto' | 'wizard' | 'normal';
  /**
   * Plugins to register from the composition layer (apps/server, apps/cli).
   * Registered after `loadExternalPlugins` so plugins discovered on disk take
   * precedence; same-name plugins are skipped to avoid double-registration.
   * Use this when a plugin is shipped as an npm dependency and isn't reachable
   * via the `<projectRoot>/plugins/<name>/dist/index.js` filesystem convention
   * (e.g. after `pnpm deploy` strips the `plugins/` tree).
   */
  additionalPlugins?: GoldpanPlugin[];
}

export interface BootstrapRepos {
  task: TaskRepository;
  source: SourceRepository;
  category: CategoryRepository;
  knowledge: KnowledgeRepository;
  eventLog: EventLogRepository;
  llmCall: LlmCallRepository;
  metadata: MetadataRepository;
  taskLog: TaskLogRepository;
  submissionLog: SubmissionLogRepository;
  /** Source-view read model (operates on `sources` table). */
  sourceView: SourceViewRepository;
  /** P1 user notes (operates on `notes` table). */
  notes: NotesRepository;
  conversation: ConversationRepository;
}

export interface BootstrapHandle {
  /**
   * Read-once snapshot at boot, with metadata language-lock applied on top
   * of `configStore.getSnapshot().config`. Use `configStore.getSnapshot()`
   * (NOT this field) when you need the LATEST config across hot-reload
   * commits. Stale-by-design for legacy callers that are read-once.
   */
  config: GoldpanConfig;
  configStore: ConfigStore;
  db: DrizzleDB;
  repos: BootstrapRepos;
  pluginRegistry: PluginRegistry;
  pipeline: Pipeline;
  /** Vercel AI SDK provider registry — resolve models via `registry.languageModel(modelId)`. */
  registry: ReturnType<typeof createLlmRegistry>;
  /** Pre-configured callLlm function that resolves step → model from config. */
  callLlm: CallLlmFn;
  /** Embedding provider (null when GOLDPAN_EMBEDDING_ENABLED is false). */
  embeddingProvider: EmbeddingProvider | null;
  logger: Logger<ILogObj>;
  /**
   * Runs every plugin's `postInit` hook. Must be called by the caller after
   * any composition-layer services (e.g. im_runtime via composeIMRuntime) are
   * attached to the registry, so plugins that look up those services in
   * postInit see them. Safe to call even when no plugin defines postInit.
   */
  runPluginPostInit(): Promise<void>;
  /**
   * Composition layer (apps/server) 在 IMRuntime ready 后 attach；
   * deferredResolver / clarify-timeout-watcher 用它向原 sessionRef 推 outbound。
   * 未 attach 时 resolver 仅写 conversation_messages（web 端 reload 可见，IM
   * 端不收 push）。core 借此对 im-runtime 保持单向依赖。
   */
  attachImSendOutbound(fn: ImSendOutbound): void;
  /** Gracefully drain worker, destroy plugins, close DB. */
  shutdown(): Promise<void>;
}

/**
 * Minimal handle returned when bootstrap detects (or is forced into) wizard
 * mode. Only carries the bare minimum needed to run `runWizardServer` —
 * `db` for the metadata table, `metadataRepo` for reading/writing onboarding
 * state, plus a `logger` and `shutdown()` for graceful teardown. There is no
 * worker, plugin registry, or pipeline in wizard mode (the user hasn't
 * configured providers yet, so we can't run any of those).
 *
 * Discriminated against `BootstrapHandle` via the `mode: 'wizard'` field —
 * `BootstrapHandle` intentionally has NO `mode` field, so `'mode' in handle`
 * (or the `isWizardHandle` type guard) narrows the union without touching
 * the existing `BootstrapHandle` shape (avoids a 30+ file cascade in
 * routes / im-runtime / im-compose consumers).
 */
export interface WizardBootstrapHandle {
  mode: 'wizard';
  db: DrizzleDB;
  metadataRepo: MetadataRepository;
  /**
   * Pre-bound `commitWizardOverrides` — `bootEnv` / `db` captured. Wizard
   * `/onboarding/commit` handler invokes this to persist staged overrides
   * before restarting the server into normal mode.
   *
   * Returns `Promise<WizardCommitResult>` (NOT `Promise<CommitResult>`) — wizard
   * commit deliberately skips constructing a snapshot (strict `loadConfig` would
   * throw on incomplete wizard config), so the result has no `snapshot` field.
   * The route layer reads `result.kind` only.
   */
  commitOverrides: (
    patch: ConfigPatch,
    options?: Pick<
      WizardCommitOptions,
      'pluginEnvKeys' | 'pluginEnvSchemas' | 'knownLlmProviderIds'
    >,
  ) => Promise<WizardCommitResult>;
  logger: Logger<ILogObj>;
  reason: WizardReason;
  hasExistingData: boolean;
  /** Closes the DB connection. No worker / plugins to drain in wizard mode. */
  shutdown(): Promise<void>;
}

/** Type guard for narrowing `bootstrap()` return value. */
export function isWizardHandle(
  h: BootstrapHandle | WizardBootstrapHandle,
): h is WizardBootstrapHandle {
  return 'mode' in h && (h as WizardBootstrapHandle).mode === 'wizard';
}

/**
 * Resolve the SQLite DB path from a frozen env snapshot. Mirrors `loadConfig`'s
 * resolution logic (`resolveProjectRoot()` + `GOLDPAN_DB_SQLITE_PATH` default)
 * so the path is identical whether the caller reaches the DB through normal
 * mode, wizard mode, or a one-shot CLI submit.
 *
 * Bootstrap calls this BEFORE branching into wizard / normal because both
 * branches need the same DB (wizard's metadata seed must survive the
 * post-commit restart into normal mode — using a separate `goldpan.wizard.db`
 * orphans everything the wizard wrote).
 */
function resolveDbPathFromEnv(env: Readonly<NodeJS.ProcessEnv>): string {
  const explicit = env.GOLDPAN_DB_SQLITE_PATH;
  if (explicit && explicit.length > 0) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(resolveProjectRoot(), explicit);
  }
  return path.resolve(resolveProjectRoot(), './data/goldpan.db');
}

const DEFAULT_CLARIFY_TIMEOUT_WATCHER_INTERVAL_MS = 6 * 3600_000;
const DEFAULT_CLARIFY_TIMEOUT_HOURS = 24;

function readPositiveNumberEnv(
  env: Readonly<NodeJS.ProcessEnv>,
  name: string,
  fallback: number,
  logger: Logger<ILogObj>,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  logger.warn('Invalid positive-number env, using default', {
    name,
    value: raw,
    fallback,
  });
  return fallback;
}

export function bootstrap(
  options: BootstrapOptions & { mode: 'wizard' },
): Promise<WizardBootstrapHandle>;
export function bootstrap(options: BootstrapOptions & { mode: 'normal' }): Promise<BootstrapHandle>;
export function bootstrap(
  options: BootstrapOptions & { mode?: 'auto' },
): Promise<BootstrapHandle | WizardBootstrapHandle>;
export async function bootstrap(
  options: BootstrapOptions,
): Promise<BootstrapHandle | WizardBootstrapHandle> {
  const {
    bootEnv,
    mode = 'auto',
    skipWorker = false,
    migrationsFolder: explicitMigrationsFolder,
  } = options;

  // Open DB + run migrations BEFORE branching. Both wizard and normal mode
  // share the same DB — wizard mode used to open a separate `wizardDb`, but
  // anything written there was orphaned at the post-commit restart (normal
  // mode reads `goldpan.db`). Sharing `db` also lets wizard-detect see
  // saved DB overrides without a second connection.
  const dbPath = resolveDbPathFromEnv(bootEnv);
  const db = createDatabase(dbPath);
  let pluginRegistry: PluginRegistry | undefined;

  try {
    const migrationsFolder = resolveMigrationsFolder(explicitMigrationsFolder);
    runMigrations(db, migrationsFolder);

    // Compute effective env (bootEnv ⊕ DB override) so wizard-detect sees
    // saved API keys etc. We deliberately do NOT use `ConfigStore` here —
    // ConfigStore runs strict `loadConfig`, which would throw on incomplete
    // wizard config and crash the wizard branch before it can render.
    const overrideRepo = new SqliteRuntimeConfigOverrideRepository(db);
    const dbOverrides = overrideRepo.list();
    const effectiveEnv: NodeJS.ProcessEnv = { ...bootEnv };
    for (const [k, v] of dbOverrides) effectiveEnv[k] = v;

    // Wizard mode detection (BEFORE strict loadConfig — loadConfig throws on bad env).
    let wizardReason: WizardReason | null = null;
    if (mode === 'wizard') {
      wizardReason = { kind: 'forced' };
    } else if (mode === 'auto') {
      const { detectWizardMode } = await import('./onboarding/wizard-mode');
      wizardReason = detectWizardMode(effectiveEnv);
    }
    // mode === 'normal' falls through; wizardReason stays null.

    if (wizardReason) {
      // ── Wizard branch — uses outer `db` (already migrated above) ───────
      const wizardLogger = createRootLogger('info');
      wizardLogger.warn('Wizard mode active — server is unauthenticated. Bind to localhost only.');

      const wizardMetadataRepo: MetadataRepository = new SqliteMetadataRepository(db);
      const wizardRawDb = getRawDatabase(db);
      const wizardHasExistingData = (() => {
        try {
          const row = wizardRawDb
            .prepare('SELECT (EXISTS(SELECT 1 FROM processing_tasks)) AS has_data')
            .get() as { has_data: number } | undefined;
          return row?.has_data === 1;
        } catch (err) {
          // Treat as fresh-DB (apply-metadata's idempotent guard prevents
          // overwriting an already-set language lock anyway), but make the
          // failure visible so a corrupt schema doesn't silently degrade
          // wizard behavior.
          wizardLogger.warn(
            `wizard existing-data probe failed (treating as fresh DB): ${errorMessage(err)}`,
          );
          return false;
        }
      })();
      // Pre-bound commitWizardOverrides — bootEnv / db captured. The wizard
      // /onboarding/commit route handler invokes this (Task 17).
      const commitOverrides: WizardBootstrapHandle['commitOverrides'] = (patch, extra) =>
        commitWizardOverrides(db, patch, {
          bootEnv,
          pluginEnvKeys: extra?.pluginEnvKeys,
          pluginEnvSchemas: extra?.pluginEnvSchemas,
          knownLlmProviderIds: extra?.knownLlmProviderIds,
        });
      let wizardShutdownPromise: Promise<void> | null = null;
      const wizardShutdown = (): Promise<void> => {
        if (wizardShutdownPromise) return wizardShutdownPromise;
        wizardShutdownPromise = (async () => {
          try {
            closeDatabase(db);
          } catch (err) {
            wizardLogger.error('Database close failed', {
              err: errorMessage(err),
            });
          }
        })();
        return wizardShutdownPromise;
      };
      return {
        mode: 'wizard',
        db,
        metadataRepo: wizardMetadataRepo,
        commitOverrides,
        logger: wizardLogger,
        reason: wizardReason,
        hasExistingData: wizardHasExistingData,
        shutdown: wizardShutdown,
      };
    }

    // ── Normal mode: ConfigStore drives strict loadConfig ────────────
    const configStore = await createConfigStore({
      db,
      bootEnv,
      applyToProcessEnv: true,
      // PR 2 fills this with plugin envSpec keys discovered during plugin load.
      pluginEnvKeys: [],
      logger: createRootLogger('info'),
    });
    const config = configStore.getSnapshot().config;
    const logger = createRootLogger(config.logLevel);

    // Repositories
    const rawDb = getRawDatabase(db);
    const taskRepo = new SqliteTaskRepository(db, rawDb);
    const categoryRepo = new SqliteCategoryRepository(db);
    const knowledgeRepo = new SqliteKnowledgeRepository(db);
    const eventLogRepo = new SqliteEventLogRepository(db);
    const llmCallRepo = new SqliteLlmCallRepository(db);
    const metadataRepo = new SqliteMetadataRepository(db);
    const taskLogRepo = new SqliteTaskLogRepository(db);
    const submissionLogRepo = new SqliteSubmissionLogRepository(db);
    const sourceViewRepo = new SqliteSourceViewRepository(db);
    const notesRepo = new SqliteNotesRepository(db);
    const conversationRepo = new SqliteConversationRepository(db);

    // P4: mutable refs — sourceRepo.onSourceTerminated closure 必须先有 referent，
    // 但 trackingPort 要在 pluginRegistry.initializeAll 之后才能填，
    // imSendOutbound 要等 composition layer (apps/server) attach。
    const trackingPortRef: { current: DeferredTrackingPort | undefined } = { current: undefined };
    const imSendOutboundRef: { current: ImSendOutbound | undefined } = { current: undefined };
    // sourceRepo 放在 knowledgeRepo / conversationRepo 之后保 lexical order；
    // P0.3 placeholder 替换为 deferredResolver.onSourceTerminated 实调用。
    const sourceRepo = new SqliteSourceRepository(db, {
      onSourceTerminated: (sourceId, status) => {
        // A3: 包 queueMicrotask 让 updateStatus 立即返回，不阻塞 pipeline。
        // resolver 当前所有路径有 try/catch；外层再加一层 defensive try/catch
        // 防 future 代码漏 catch 时 microtask 抛错触发 process crash
        // (unhandled exception in microtask 在 Node 22+ 是 fatal)。
        queueMicrotask(() => {
          try {
            onSourceTerminated(sourceId, status, {
              db,
              knowledge: knowledgeRepo,
              conversation: conversationRepo,
              trackingPort: trackingPortRef.current,
              imSendOutbound: imSendOutboundRef.current,
              logger,
            });
          } catch (err) {
            logger.error('onSourceTerminated callback threw (swallowed in microtask)', {
              sourceId,
              status,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        });
      },
    });

    // i18n initialization (after migrations, before pipeline/worker)
    const hasExistingData = (() => {
      try {
        const row = rawDb
          .prepare('SELECT (EXISTS(SELECT 1 FROM processing_tasks)) AS has_data')
          .get() as { has_data: number } | undefined;
        return row?.has_data === 1;
      } catch {
        return false;
      }
    })();
    const actualLanguage = resolveLanguageLock(metadataRepo, config.language, {
      hasExistingData,
      warn: (msg) => logger.warn(msg),
    });
    initI18n(actualLanguage);
    const effectiveConfig =
      actualLanguage !== config.language ? { ...config, language: actualLanguage } : config;
    validatePromptFiles(actualLanguage);

    // FTS5 tables (language-aware tokenizer, after language lock)
    ensureFtsTables(rawDb, actualLanguage);

    // Plugins — PluginRegistry must exist before createLlmRegistry can resolve LlmProviderPlugin entries (PR 2).
    // Outer `pluginRegistry: PluginRegistry | undefined` is for the try-catch
    // cleanup; assigning a `const` alias here lets downstream consumers treat
    // it as non-null without scattering `pluginRegistry!` assertions.
    const pluginLogger = createSubLogger(logger, 'core.plugins');
    const registryInstance = new PluginRegistry({
      collectTimeoutSeconds: effectiveConfig.collectTimeout,
      logger: pluginLogger,
    });
    pluginRegistry = registryInstance;

    // LLM
    const registry = createLlmRegistry(configStore, registryInstance);
    const llmLogger = createSubLogger(logger, 'core.llm');

    // Embedding (opt-in via GOLDPAN_EMBEDDING_ENABLED)
    let embeddingProvider: EmbeddingProvider | null = null;
    if (effectiveConfig.embedding.enabled) {
      const { load: loadSqliteVec } = await import('sqlite-vec');
      loadSqliteVec(rawDb);

      let dims = effectiveConfig.embedding.dimensions;
      if (dims === 0) {
        const storedDims = metadataRepo.get('embedding_dimensions');
        const storedModel = metadataRepo.get('embedding_model');
        const parsedDims = Number(storedDims);
        if (
          storedDims &&
          storedModel === effectiveConfig.embedding.model &&
          Number.isFinite(parsedDims) &&
          parsedDims > 0
        ) {
          dims = parsedDims;
        } else {
          const { embed } = await import('ai');
          const tempModel = registry.embeddingModel(
            effectiveConfig.embedding.model as `${string}:${string}`,
          );
          const { embedding } = await embed({ model: tempModel, value: 'dimension probe' });
          dims = embedding.length;
          logger.info(`[embedding] Detected dimensions: ${dims}`);
        }
      }

      embeddingProvider = new AiSdkEmbeddingProvider(
        registry,
        effectiveConfig.embedding.model,
        dims,
      );
      ensureVecTables(rawDb, effectiveConfig.embedding.model, dims);
      try {
        await backfillEmbeddings(
          rawDb,
          embeddingProvider,
          effectiveConfig.embedding.batchSize,
          logger,
        );
      } catch (err) {
        logger.warn('[embedding] Backfill failed (will retry on next restart)', {
          err: errorMessage(err),
        });
      }
    }

    const resolvedCallLlm: CallLlmFn = (opts) => {
      const modelKey = STEP_TO_MODEL_KEY[opts.step];
      if (!modelKey) {
        throw new Error(`Unknown LLM step "${opts.step}"`);
      }
      // registry.languageModel resolves modelId via config.llm[modelKey] and
      // wraps with providerOptions middleware when configured for this step.
      const model = registry.languageModel(modelKey);
      // Central per-step timeout resolution: caller-supplied timeout wins
      // (test seams), otherwise GOLDPAN_LLM_<STEP>_TIMEOUT, falling back to
      // global GOLDPAN_LLM_TIMEOUT. Read from configStore.getSnapshot() on
      // every call so per-step timeout edits committed via the settings UI
      // take effect on the next retry without a server restart —
      // `effectiveConfig` is the boot-time frozen snapshot and would freeze
      // timeouts at 30s forever for callers like the pipeline worker.
      const currentConfig = configStore.getSnapshot().config;
      const timeout = opts.timeout ?? resolveStepTimeout(currentConfig, modelKey);
      return callLlm({ ...opts, model, timeout, logger: llmLogger });
    };

    const serviceCallLlm: ServiceCallLlmFn = (opts) => {
      return resolvedCallLlm({
        ...opts,
        sourceId: opts.sourceId ?? null,
        llmCallRepo,
        // logPayloads also reads live so a runtime toggle takes effect on the
        // next call; same hot-reload rationale as the timeout above.
        logPayloads: configStore.getSnapshot().config.llmLogPayloads,
        logger: llmLogger,
      });
    };

    const serviceSubmitInput = async (
      input: string,
      options?: { origin?: 'user' | 'tracking' },
    ): Promise<SubmitResult> => {
      return submitInputFn(input, {
        db,
        submissionLog: submissionLogRepo,
        // Hot (no-restart): live snapshot; ssrf stays frozen (restart-required).
        maxTextInputLength: configStore.getSnapshot().config.maxTextInputLength,
        ssrfValidationEnabled: effectiveConfig.ssrfValidationEnabled,
        origin: options?.origin,
      });
    };

    // External plugins load first so they can override built-ins via higher priority.
    // If an external plugin registers the same intent at the same priority (0),
    // the built-in registration below will throw — this is intentional to catch conflicts.
    await loadExternalPlugins({
      logger,
      pluginRegistry,
    });
    for (const extra of options.additionalPlugins ?? []) {
      if (pluginRegistry.hasPlugin(extra.name)) {
        logger.info('additional plugin already registered (filesystem won), skipping', {
          pluginName: extra.name,
        });
        continue;
      }
      pluginRegistry.register(extra);
    }
    pluginRegistry.register(collectorWebPlugin);

    // Built-in intent plugins
    pluginRegistry.register(intentSubmitPlugin);
    pluginRegistry.register(intentQueryPlugin);
    // P2: intent-note —— 直接写 notes 表，不走 LLM / pipeline
    pluginRegistry.register(intentNotePlugin);

    const serviceCapabilities: ServiceCapabilities = {
      db,
      config: effectiveConfig,
      pluginRegistry,
      submitInput: serviceSubmitInput,
      callLlm: serviceCallLlm,
    };

    const pluginContext: PluginContext = {
      logger,
      configStore,
      pluginConfig: {
        collectTimeoutSeconds: effectiveConfig.collectTimeout,
        browserStrategy: effectiveConfig.browserStrategy,
        ssrfValidationEnabled: effectiveConfig.ssrfValidationEnabled,
        // collector-media 字段
        mediaCollectTimeoutSeconds: effectiveConfig.mediaCollectTimeout,
        ytDlpAutoUpdate: effectiveConfig.ytDlpAutoUpdate,
        ytDlpVersion: effectiveConfig.ytDlpVersion,
        ytDlpBinaryPath: effectiveConfig.ytDlpBinaryPath,
        ytDlpDir: effectiveConfig.ytDlpDir,
        ytDlpUpdateCheckIntervalH: effectiveConfig.ytDlpUpdateCheckIntervalH,
        ytDlpCookiesPath: effectiveConfig.ytDlpCookiesPath,
        dataDir: path.dirname(effectiveConfig.db.sqlitePath),
        language: effectiveConfig.language,
      },
    };
    await pluginRegistry.initializeAll(pluginContext, serviceCapabilities);
    const runPluginPostInit = (): Promise<void> => {
      if (!pluginRegistry) {
        throw new Error('pluginRegistry is not initialized');
      }
      return pluginRegistry.runPostInit(pluginContext, serviceCapabilities);
    };

    // P4: tracking plugin 暴露 5 个 deferred method → 适配成 DeferredTrackingPort
    // 填入 trackingPortRef。tracking 未 load 时 ref 保持 undefined，
    // deferredResolver / clarifyTimeoutWatcher 自动跳过 tracking 分支
    // （resolver 仍跑 note backfill）。
    const trackingForDeferred = registryInstance.getService<{
      findPendingByPipelineSource: (id: number) => Array<{
        id: number;
        pendingResolution: PendingResolutionPayload | null;
      }>;
      markResolved: (
        id: number,
        input: {
          name: string;
          searchQueries: string[];
          linkedEntityIds: number[];
          expectedStatus: DeferredResolutionStatus;
        },
      ) => boolean;
      markFailedResolution: (
        id: number,
        input: {
          targetStatus: 'failed_no_entity' | 'failed_source_pipeline';
          expectedStatus: DeferredResolutionStatus;
        },
      ) => boolean;
      markAwaitingClarify: (
        id: number,
        input: {
          candidateEntityIds: number[];
          expectedStatus: DeferredResolutionStatus;
        },
      ) => boolean;
      findAwaitingClarifyOlderThan: (cutoffMs: number) => Array<{
        id: number;
        pendingResolution: PendingResolutionPayload | null;
      }>;
    }>('tracking');
    if (trackingForDeferred) {
      trackingPortRef.current = {
        findPendingByPipelineSource: (sid) => trackingForDeferred.findPendingByPipelineSource(sid),
        markResolved: (id, input) => trackingForDeferred.markResolved(id, input),
        markFailedResolution: (id, input) => trackingForDeferred.markFailedResolution(id, input),
        markAwaitingClarify: (id, input) => trackingForDeferred.markAwaitingClarify(id, input),
        findAwaitingClarifyOlderThan: (cut) =>
          trackingForDeferred.findAwaitingClarifyOlderThan(cut),
      };
    }

    // P4: clarify-timeout-watcher — awaiting_clarify > 24h 自动 fail + 提醒。
    // tracking port 不在时不启动（没数据可扫）。
    let stopClarifyTimeoutWatcher: (() => void) | null = null;
    if (trackingPortRef.current) {
      const trackingPort = trackingPortRef.current;
      stopClarifyTimeoutWatcher = startClarifyTimeoutWatcher({
        port: trackingPort,
        intervalMs: readPositiveNumberEnv(
          process.env,
          'GOLDPAN_CLARIFY_TIMEOUT_WATCHER_INTERVAL_MS',
          DEFAULT_CLARIFY_TIMEOUT_WATCHER_INTERVAL_MS,
          logger,
        ),
        timeoutHours: readPositiveNumberEnv(
          process.env,
          'GOLDPAN_CLARIFY_TIMEOUT_HOURS',
          DEFAULT_CLARIFY_TIMEOUT_HOURS,
          logger,
        ),
        logger,
        pushAssistant: (payload, message, ruleId) => {
          // B11: 构造与 deferred/resolver 同 shape 的 IntentPluginResult，
          // 让 extractAssistantTurn 产出统一 metadata（resultType=action +
          // trackingRuleId），web UI 只需一条 render 分支即可。
          const result = {
            type: 'action' as const,
            message,
            actionId: `tracking-${ruleId}-failed_no_entity_timeout`,
          };
          if (payload.conversationId > 0) {
            const conv = conversationRepo.loadConversationById(payload.conversationId);
            if (!conv?.archivedAt) {
              const turn = extractAssistantTurn(result);
              if (turn) {
                conversationRepo.appendMessage(payload.conversationId, {
                  role: 'assistant',
                  content: turn.content,
                  metadata: { ...turn.metadata, trackingRuleId: ruleId },
                });
              }
            }
          }
          if (payload.sessionRef && imSendOutboundRef.current) {
            void imSendOutboundRef
              .current(payload.sessionRef.channelId, payload.sessionRef, result)
              .catch((err) =>
                logger.warn('clarify timeout im push failed', { err: errorMessage(err) }),
              );
          }
        },
      });
    }

    // Pipeline — `configStore` (NOT `effectiveConfig`) is what the orchestrator
    // wants. The orchestrator freezes a per-task snapshot at each `process()`
    // entry. The frozen snapshot governs non-LLM config (thresholds, timeouts,
    // language, etc.) for the duration of one task; LLM model + API key are
    // deliberately NOT frozen — `registry.languageModel` resolves both from
    // `configStore.getSnapshot()` at each call so a mid-task commit to
    // `GOLDPAN_LLM_<STEP>` / `OPENAI_API_KEY` takes effect on the next step
    // in the in-flight task. This matches the PR1 hot-reload contract pinned
    // by `tests/integration/llm-hot-reload.test.ts`.
    //
    // `effectiveConfig` is still used elsewhere in bootstrap for boot-time
    // concerns (embedding probe, plugin context, serviceCallLlm), so it
    // deliberately doesn't go away here.
    const pipelineLogger = createSubLogger(logger, 'core.pipeline');
    const pipeline = createPipeline({
      taskRepo,
      sourceRepo,
      categoryRepo,
      knowledgeRepo,
      eventLogRepo,
      callLlm: resolvedCallLlm,
      llmCallRepo,
      registry,
      pluginRegistry,
      configStore,
      db,
      logger: pipelineLogger,
      taskLogRepo,
      embeddingProvider,
      steps: {
        collecting: executeCollecting,
        classifying: executeClassifying,
        extracting: executeExtracting,
        matching: executeMatching,
        relating: executeRelating,
        comparing: executeComparing,
        verifying: executeVerifying,
        validatePipelineOutput: async (ctx, deps) => validatePipelineOutput(ctx, deps),
        translating: executeTranslating,
        storing: executeStoring,
      },
    });

    // Worker (optional)
    if (!skipWorker) {
      const workerLogger = createSubLogger(logger, 'core.worker');
      startWorker({
        taskRepo,
        sourceRepo,
        workerInterval: effectiveConfig.workerInterval,
        logger: workerLogger,
        pipeline,
        config: effectiveConfig,
        db,
      });
    }

    // P3 Path E: bufferWatcher — 后台 cron 兜底 Path A/B/C/D 都没触发的
    // expired buffered_wait 消息。Recursive setTimeout（与 worker.ts 同模式），
    // 不用 setInterval 避免 finalize 慢时多 tick 重叠。
    // 可通过 GOLDPAN_DISABLE_BUFFER_WATCHER=true 关闭（测试 / 调试）。
    //
    // B4: gate 同 startWorker —— skipWorker 进程（如 web）不跑全局扫描，避免
    // 多进程部署时所有 worker/web/server 都扫同一张表 + 重复 finalize 竞争。
    const bufferWatcherLogger = createSubLogger(logger, 'core.bufferWatcher');
    const stopBufferWatcher = skipWorker
      ? () => {}
      : startBufferWatcher({
          db,
          repo: conversationRepo,
          intervalMs: Number(process.env.GOLDPAN_BUFFER_WATCHER_INTERVAL_MS ?? 300000),
          graceMs: Number(process.env.GOLDPAN_BUFFER_WATCHER_GRACE_MS ?? 30000),
          batchSize: 50,
          logger: bufferWatcherLogger,
          finalize: (messageId) =>
            finalizeBuffer(messageId, {
              db,
              repos: {
                llmCall: llmCallRepo,
                submissionLog: submissionLogRepo,
                knowledge: knowledgeRepo,
                category: categoryRepo,
                notes: notesRepo,
                source: sourceRepo,
                conversation: conversationRepo,
              },
              logger: bufferWatcherLogger,
              handleInput,
              callLlm: serviceCallLlm,
              // closure 捕获 — 用 const 引用避开 `let pluginRegistry` 的
              // `| undefined` widening（finalize 执行时 TS 已不能保证未被重赋值）。
              pluginRegistry: registryInstance,
              config: effectiveConfig,
              embeddingProvider: embeddingProvider ?? undefined,
            }),
        });

    // Tracking scheduler (opt-in, only with worker)
    if (!skipWorker && effectiveConfig.tracking.schedulerEnabled) {
      const trackingService = pluginRegistry.getService<{ startScheduler: () => void }>('tracking');
      if (trackingService) {
        trackingService.startScheduler();
        logger.info('Tracking scheduler started');
      }
    } else if (effectiveConfig.tracking.schedulerEnabled && skipWorker) {
      logger.warn(
        'Tracking scheduler enabled but worker is disabled in this process — scheduler will not start',
      );
    }

    const repos: BootstrapRepos = {
      task: taskRepo,
      source: sourceRepo,
      category: categoryRepo,
      knowledge: knowledgeRepo,
      eventLog: eventLogRepo,
      llmCall: llmCallRepo,
      metadata: metadataRepo,
      taskLog: taskLogRepo,
      submissionLog: submissionLogRepo,
      sourceView: sourceViewRepo,
      notes: notesRepo,
      conversation: conversationRepo,
    };

    let shutdownPromise: Promise<void> | null = null;
    const shutdown = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        logger.info('Shutdown signal received, draining...');

        // 1. Drain tracking scheduler first (stop producing new tasks)
        try {
          const trackingService = pluginRegistry?.getService<{
            drainScheduler: () => Promise<void>;
          }>('tracking');
          if (trackingService) {
            await trackingService.drainScheduler();
          }
        } catch (err) {
          logger.error('Tracking scheduler drain failed', {
            err: errorMessage(err),
          });
        }

        // 2. Drain worker (process remaining tasks)
        try {
          await drainAndStop();
        } catch (err) {
          logger.error('Worker drain failed', {
            err: errorMessage(err),
          });
        }

        // 2b. Stop bufferWatcher (sync — no in-flight to await; recursive
        // setTimeout's stop() flag prevents new ticks after the current one).
        try {
          stopBufferWatcher();
        } catch (err) {
          logger.warn('stopBufferWatcher failed during shutdown', {
            err: errorMessage(err),
          });
        }

        // 2c. Stop clarifyTimeoutWatcher (同 bufferWatcher 模式)。
        try {
          stopClarifyTimeoutWatcher?.();
        } catch (err) {
          logger.warn('stopClarifyTimeoutWatcher failed during shutdown', {
            err: errorMessage(err),
          });
        }

        // 3. Destroy all plugins
        try {
          await pluginRegistry?.destroyAll();
        } catch (err) {
          logger.error('Plugin registry destroy failed', {
            err: errorMessage(err),
          });
          if (err instanceof AggregateError) {
            for (const subErr of err.errors) {
              logger.error('  plugin destroy sub-error', {
                err: errorMessage(subErr),
                stack: subErr instanceof Error ? subErr.stack : undefined,
              });
            }
          }
        }

        // 4. Close DB
        try {
          closeDatabase(db);
        } catch (err) {
          logger.error('Database close failed', {
            err: errorMessage(err),
          });
        }
        logger.info('Shutdown complete');
      })();
      return shutdownPromise;
    };

    return {
      config: effectiveConfig,
      configStore,
      db,
      repos,
      pluginRegistry: registryInstance,
      pipeline,
      registry,
      callLlm: resolvedCallLlm,
      embeddingProvider,
      logger,
      runPluginPostInit,
      attachImSendOutbound: (fn) => {
        imSendOutboundRef.current = fn;
      },
      shutdown,
    };
  } catch (err) {
    // Clean up resources already allocated before re-throwing
    if (pluginRegistry) {
      try {
        await pluginRegistry.destroyAll();
      } catch {
        // best-effort cleanup
      }
    }
    try {
      closeDatabase(db);
    } catch {
      // best-effort cleanup during init failure
    }
    throw err;
  }
}
