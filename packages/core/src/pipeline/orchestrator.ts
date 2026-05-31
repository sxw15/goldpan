import type { ILogObj, Logger } from 'tslog';
import type { GoldpanConfig } from '../config/index';
import type { ConfigStore } from '../config/store-types';
import { type DrizzleDB, getRawDatabase } from '../db/connection';
import {
  type CategoryRepository,
  type EventLogRepository,
  type InputType,
  type KnowledgeRepository,
  type LlmCallRepository,
  type LlmStep,
  type PipelineStep,
  type SourceRepository,
  type TaskLogRepository,
  type TaskRepository,
  VALID_INPUT_TYPES,
} from '../db/repositories/types';
import { errorMessage } from '../errors';
import { createRootLogger, createSubLogger } from '../logger/index';
import { CollectorError } from '../plugins/errors';
import type { PluginRegistry } from '../plugins/registry';
import { truncate } from '../utils/truncate';
import { type CallLlmFn, type PipelineContext, PipelineError } from './types';

export type StepFn = (ctx: PipelineContext, deps: PipelineDeps) => Promise<PipelineContext>;

export interface PipelineSteps {
  collecting: StepFn;
  classifying: StepFn;
  extracting: StepFn;
  matching: StepFn;
  relating: StepFn;
  comparing: StepFn;
  verifying: StepFn;
  translating: StepFn;
  validatePipelineOutput: StepFn;
  storing: StepFn;
}

/**
 * EXTERNAL input — what `bootstrap` (and tests) pass to `createPipeline`.
 * Carries `configStore` instead of a frozen `config`. The orchestrator pulls a
 * fresh snapshot via `configStore.getSnapshot()` at the start of EACH
 * `process()` call and freezes it as `deps.config` for the task's lifetime.
 *
 * This split (Input vs internal `PipelineDeps`) enforces the spec invariant
 * "task 内 config 不变": step files MUST NOT pull a fresh snapshot mid-task.
 * The orchestrator binds the same task-scoped snapshot to both `deps.config`
 * and `ctx.config`, and `configStore` is intentionally absent from
 * `PipelineDeps`.
 */
export interface PipelineDepsInput {
  configStore: ConfigStore;
  categoryRepo: CategoryRepository;
  sourceRepo: SourceRepository;
  knowledgeRepo: KnowledgeRepository;
  taskRepo: TaskRepository;
  eventLogRepo: EventLogRepository;
  callLlm: CallLlmFn;
  llmCallRepo: LlmCallRepository;
  registry?: ReturnType<typeof import('../llm/registry').createLlmRegistry>;
  pluginRegistry: PluginRegistry;
  db: DrizzleDB;
  steps: PipelineSteps;
  logger?: Logger<ILogObj>;
  taskLogRepo?: TaskLogRepository;
  embeddingProvider?: import('../embedding/types').EmbeddingProvider | null;
}

/**
 * INTERNAL deps — what step files see as their second parameter. `config` is
 * a frozen, task-scoped snapshot that the orchestrator rebuilds at each
 * `process()` entry. The same snapshot is also copied into `ctx.config` for
 * existing step code. There is deliberately NO `configStore` here so a step
 * can't accidentally pull a fresh snapshot mid-task.
 */
export interface PipelineDeps {
  /**
   * Frozen snapshot for the duration of one task. A user-initiated config
   * commit during task execution does NOT propagate to subsequent steps of
   * the in-flight task; the next task's `process()` call picks up the new
   * snapshot. See `createPipeline()` for the bind point.
   */
  config: GoldpanConfig;
  categoryRepo: CategoryRepository;
  sourceRepo: SourceRepository;
  knowledgeRepo: KnowledgeRepository;
  taskRepo: TaskRepository;
  eventLogRepo: EventLogRepository;
  callLlm: CallLlmFn;
  llmCallRepo: LlmCallRepository;
  registry?: ReturnType<typeof import('../llm/registry').createLlmRegistry>;
  pluginRegistry: PluginRegistry;
  db: DrizzleDB;
  steps: PipelineSteps;
  logger?: Logger<ILogObj>;
  taskLogRepo?: TaskLogRepository;
  embeddingProvider?: import('../embedding/types').EmbeddingProvider | null;
}

export interface Pipeline {
  process(ctx: PipelineContext): Promise<PipelineContext>;
}

export function createPipeline(input: PipelineDepsInput): Pipeline {
  const { configStore, ...rest } = input;
  const { steps, taskRepo, sourceRepo, taskLogRepo, pluginRegistry } = rest;
  // Pipeline-construction-time logger only. `deps.config.logLevel` for any
  // given task comes from that task's frozen snapshot; the construction-time
  // logger choice doesn't need to track per-commit changes — it's just for
  // orchestrator-internal logs (step:start / done / error).
  const constructionConfig = configStore.getSnapshot().config;
  const logger =
    rest.logger ??
    createSubLogger(createRootLogger(constructionConfig.logLevel ?? 'info'), 'core.pipeline');

  function logStep(
    taskId: number,
    step: PipelineStep,
    event: 'start' | 'end' | 'error' | 'skip',
    opts?: { message?: string; inputSummary?: string; outputSummary?: string },
  ) {
    if (!taskLogRepo) return;
    try {
      taskLogRepo.create({
        taskId,
        step,
        event,
        message: opts?.message,
        inputSummary: opts?.inputSummary,
        outputSummary: opts?.outputSummary,
      });
    } catch (e) {
      logger.warn('taskLogRepo.create failed', {
        taskId,
        step,
        event,
        error: errorMessage(e),
      });
    }
  }

  async function process(ctx: PipelineContext): Promise<PipelineContext> {
    // Per-task config snapshot — the spec invariant "task 内 config 不变".
    // Pulled ONCE at process() entry; every step in this task receives the
    // same `taskDeps` (and therefore the same `taskDeps.config`). A
    // configStore.commit() during step execution does NOT bleed into
    // subsequent steps of the in-flight task; the next process() call
    // picks up the new snapshot.
    const taskConfig = configStore.getSnapshot().config;
    const taskDeps: PipelineDeps = { ...rest, config: taskConfig };
    // Step implementations still read `ctx.config` in many places; bind the
    // same per-task snapshot into the context so hot-reloaded config applies
    // on the next task without leaking mid-task changes.
    ctx = { ...ctx, config: taskConfig };

    let currentStep: PipelineStep = 'collecting';

    async function runStep(
      stepName: PipelineStep,
      fn: StepFn,
      ctx: PipelineContext,
    ): Promise<PipelineContext> {
      currentStep = stepName;
      logger.info(`step:${stepName} start`, { taskId: ctx.task.id });

      const inputSummary = await summarizeInput(stepName, ctx, pluginRegistry, logger);
      logStep(ctx.task.id, stepName, 'start', { inputSummary });

      if (typeof taskRepo.updatePipelineStep === 'function') {
        try {
          taskRepo.updatePipelineStep(ctx.task.id, stepName);
        } catch (e) {
          logger.warn('updatePipelineStep failed, continuing pipeline', {
            taskId: ctx.task.id,
            step: stepName,
            error: errorMessage(e),
          });
        }
      }

      const result = await fn(ctx, taskDeps);

      const outputSummary = summarizeOutput(stepName, result, logger);
      logger.info(`step:${stepName} done`, { taskId: ctx.task.id });
      logStep(ctx.task.id, stepName, 'end', { outputSummary });
      return result;
    }

    try {
      // Bootstrap inputType from task/source if null
      if (ctx.inputType === null) {
        const taskInputType = ctx.task.inputType ?? null;
        if (taskInputType && VALID_INPUT_TYPES.has(taskInputType)) {
          ctx = { ...ctx, inputType: taskInputType as InputType };
        } else if (ctx.source.kind === 'external') {
          ctx = { ...ctx, inputType: 'url' };
        }
      }

      // Step 1: Collecting (skip if content already present)
      if (!ctx.content) {
        ctx = await runStep('collecting', steps.collecting, ctx);
      }

      // Step 2: Classifying
      ctx = await runStep('classifying', steps.classifying, ctx);

      // Step 3: Extracting
      ctx = await runStep('extracting', steps.extracting, ctx);

      // Zero extraction → short-circuit to storing
      if (ctx.points.length === 0) {
        logger.info('zero extraction — skipping to storing', { taskId: ctx.task.id });
        for (const skipped of [
          'matching',
          'relating',
          'comparing',
          'verifying',
          'validatePipelineOutput',
          'translating',
        ] as const) {
          logStep(ctx.task.id, skipped, 'skip', { message: 'zero extraction' });
        }
        ctx = { ...ctx, validationResult: { validEntities: [], droppedPoints: [], warnings: [] } };
        ctx = await runStep('storing', steps.storing, ctx);
        return ctx;
      }

      // Step 4: Matching
      ctx = await runStep('matching', steps.matching, ctx);

      // Step 5: Relating (entity relationship extraction)
      ctx = await runStep('relating', steps.relating, ctx);

      // Step 6: Comparing
      ctx = await runStep('comparing', steps.comparing, ctx);

      // Step 6: Verifying
      ctx = await runStep('verifying', steps.verifying, ctx);

      // Step 7: Validate pipeline output
      ctx = await runStep('validatePipelineOutput', steps.validatePipelineOutput, ctx);

      // Step 7.5: Translating (optional — gated by config.translation.translatePipelineOutput).
      // Runs after validation so we only translate what will actually be stored,
      // and before storing so the storing step persists translated columns in
      // the same transaction as the originals.
      ctx = await runStep('translating', steps.translating, ctx);

      // Step 8: Storing
      ctx = await runStep('storing', steps.storing, ctx);

      return ctx;
    } catch (error) {
      if (error instanceof PipelineError) {
        logger.error(`pipeline error at step:${currentStep}`, {
          taskId: ctx.task.id,
          kind: error.kind,
          message: error.message,
        });
      } else {
        logger.error('unexpected pipeline error', {
          taskId: ctx.task.id,
          error: errorMessage(error),
        });
      }

      logStep(ctx.task.id, currentStep, 'error', {
        message: errorMessage(error),
      });

      // Update task/source status atomically in a single transaction
      try {
        const rawStep = error instanceof PipelineError ? error.step : currentStep;
        // Map LlmStep (noun form) to PipelineStep (gerund form) if needed
        const step = mapToPipelineStep(rawStep) ?? currentStep;
        const msg = errorMessage(error);
        const kind = error instanceof PipelineError ? error.kind : 'unknown';
        // executeCollecting wraps any non-PipelineError into a PipelineError
        // with the original as `.cause`, so we must unwrap to recover the
        // collector code. A raw CollectorError can still reach here in tests
        // or if a future step is wired without the wrapping layer.
        const collectorErr: CollectorError | null =
          error instanceof CollectorError
            ? error
            : error instanceof PipelineError && error.cause instanceof CollectorError
              ? error.cause
              : null;
        const doUpdate = () => {
          taskRepo.markError(ctx.task.id, step, msg, kind);
          sourceRepo.updateStatus(ctx.source.id, 'failed', { emitTerminated: false });
          if (step === 'collecting' && collectorErr?.code) {
            // Persist a vendor-neutral, lowercase failure code so downstream
            // refresh flows (e.g. GithubService.refreshRepoByNormalizedUrl)
            // can short-circuit terminal failures without re-hitting the
            // collector.
            sourceRepo.mergeMetadata(ctx.source.id, {
              collector_failure_code: collectorErr.code.toLowerCase(),
            });
          }
        };
        try {
          const raw = getRawDatabase(taskDeps.db);
          raw.transaction(doUpdate).immediate();
          sourceRepo.emitTerminated(ctx.source.id, 'failed');
        } catch (txError) {
          // Transaction failed — do NOT fall back to non-transactional writes.
          // Worker safety net (worker.ts) will handle persisting error state.
          logger.error(
            'Transaction failed for error status update, skipping non-transactional fallback',
            {
              taskId: ctx.task.id,
              error: errorMessage(txError),
            },
          );
        }
      } catch (statusError) {
        logger.error('failed to update task/source status after error', {
          taskId: ctx.task.id,
          error: errorMessage(statusError),
        });
      }

      throw error;
    }
  }

  return { process };
}

/** Maps pipeline-phase LlmSteps to PipelineSteps. Intent/query steps are not pipeline phases. */
type PipelineLlmStep =
  | 'classifier'
  | 'extractor'
  | 'matcher'
  | 'comparator'
  | 'verifier'
  | 'relator'
  | 'translator';
const LLM_STEP_TO_PIPELINE_STEP: Record<PipelineLlmStep, PipelineStep> = {
  classifier: 'classifying',
  extractor: 'extracting',
  matcher: 'matching',
  comparator: 'comparing',
  verifier: 'verifying',
  relator: 'relating',
  translator: 'translating',
};

const VALID_PIPELINE_STEPS = new Set<string>([
  'collecting',
  'classifying',
  'extracting',
  'matching',
  'relating',
  'comparing',
  'verifying',
  'translating',
  'validatePipelineOutput',
  'storing',
  'content_validation',
]);

export function mapToPipelineStep(step: PipelineStep | LlmStep | null): PipelineStep | null {
  if (step === null) return null;
  const mapped = LLM_STEP_TO_PIPELINE_STEP[step as PipelineLlmStep];
  if (mapped) return mapped;
  if (VALID_PIPELINE_STEPS.has(step)) return step as PipelineStep;
  return null;
}

// ─── Step I/O Summaries ─────────────────────────────────────

async function summarizeInput(
  step: PipelineStep,
  ctx: PipelineContext,
  pluginRegistry: PluginRegistry,
  logger: Logger<ILogObj>,
): Promise<string | undefined> {
  try {
    switch (step) {
      case 'collecting': {
        if (ctx.inputType !== 'url') {
          return JSON.stringify({
            sourceKind: ctx.source.kind,
            url: ctx.source.originalUrl ?? null,
            inputType: ctx.inputType,
          });
        }
        const url = ctx.source.originalUrl ?? ctx.source.normalizedUrl;
        const collectorCandidates =
          url && typeof url === 'string'
            ? await pluginRegistry.listMatchingCollectorNames(url)
            : [];
        return JSON.stringify({
          sourceKind: ctx.source.kind,
          url: ctx.source.originalUrl ?? null,
          inputType: ctx.inputType,
          collectorCandidates,
        });
      }
      case 'classifying':
        return JSON.stringify({
          contentLength: ctx.content?.length ?? 0,
          inputType: ctx.inputType,
        });
      case 'extracting':
        return JSON.stringify({
          contentLength: ctx.content?.length ?? 0,
          category: ctx.classification?.categoryPath ?? null,
          keywords: ctx.classification?.keywords ?? [],
        });
      case 'matching':
        return JSON.stringify({
          pointCount: ctx.points.length,
          points: ctx.points.map((p) => ({
            key: p.pointKey,
            type: p.type,
            content: truncate(p.content, 80, '...'),
          })),
        });
      case 'relating':
        return JSON.stringify({
          entityCount: ctx.matchingOutput?.entities?.length ?? 0,
          pointCount: ctx.points.length,
        });
      case 'comparing':
        return JSON.stringify({
          entityCount: ctx.matchingOutput?.entities?.length ?? 0,
          entities: (ctx.matchingOutput?.entities ?? []).map(
            (e: { entityKey: string; entityName?: string; knowledgePointKeys?: string[] }) => ({
              key: e.entityKey,
              name: e.entityName ?? e.entityKey,
              pointCount: e.knowledgePointKeys?.length ?? 0,
            }),
          ),
        });
      case 'verifying':
        return JSON.stringify({
          entityCount: ctx.entityJudgments.length,
          totalPoints: ctx.entityJudgments.reduce((n, e) => n + e.pointJudgments.length, 0),
          newPoints: ctx.entityJudgments.reduce(
            (n, e) => n + e.pointJudgments.filter((p) => p.judgment === 'new').length,
            0,
          ),
        });
      case 'validatePipelineOutput':
        return JSON.stringify({
          entityCount: ctx.entityJudgments.length,
          rejectionCount: ctx.verifierRejections.length,
        });
      case 'translating':
        return JSON.stringify({
          enabled: ctx.config.translation.translatePipelineOutput,
          targetLanguage: ctx.config.language,
          validEntityCount: ctx.validationResult?.validEntities.length ?? 0,
          relationCount: ctx.validationResult?.validRelations?.length ?? 0,
        });
      case 'storing':
        return JSON.stringify({
          validEntityCount: ctx.validationResult?.validEntities.length ?? 0,
          droppedPointCount: ctx.validationResult?.droppedPoints.length ?? 0,
          warnings: ctx.validationResult?.warnings.length ?? 0,
          translationsApplied: Object.keys(ctx.translations ?? {}).length,
        });
      default:
        return undefined;
    }
  } catch (err) {
    logger.debug('summarizeInput serialization failed', {
      step,
      error: errorMessage(err),
    });
    return undefined;
  }
}

function summarizeOutput(
  step: PipelineStep,
  ctx: PipelineContext,
  logger: Logger<ILogObj>,
): string | undefined {
  try {
    switch (step) {
      case 'collecting': {
        const base: Record<string, unknown> = {
          contentLength: ctx.content?.length ?? 0,
          title: ctx.source.title ?? null,
          collectorPlugin: ctx.collectorPluginName ?? null,
        };
        if (ctx.collectingDiagnostics?.length) {
          base.collectorDiagnostics = ctx.collectingDiagnostics;
        }
        if (ctx.collectorBrowserEngine) {
          base.collectorBrowserEngine = ctx.collectorBrowserEngine;
        }
        if (ctx.collectorBrowserEngineLabel) {
          base.collectorBrowserEngineLabel = ctx.collectorBrowserEngineLabel;
        }
        return JSON.stringify(base);
      }
      case 'classifying':
        return JSON.stringify({
          category: ctx.classification?.categoryPath ?? null,
          keywords: ctx.classification?.keywords ?? [],
          inputType: ctx.inputType,
        });
      case 'extracting':
        return JSON.stringify({
          pointCount: ctx.points.length,
          points: ctx.points.map((p) => ({
            key: p.pointKey,
            type: p.type,
            content: truncate(p.content, 80, '...'),
          })),
        });
      case 'matching':
        return JSON.stringify({
          entityCount: ctx.matchingOutput?.entities?.length ?? 0,
          entities: (ctx.matchingOutput?.entities ?? []).map(
            (e: { entityKey: string; entityName?: string }) => ({
              key: e.entityKey,
              name: e.entityName ?? e.entityKey,
            }),
          ),
        });
      case 'relating':
        return JSON.stringify({
          relationCount: ctx.relations?.length ?? 0,
        });
      case 'comparing': {
        const newCount = ctx.entityJudgments.reduce(
          (n, e) => n + e.pointJudgments.filter((p) => p.judgment === 'new').length,
          0,
        );
        const skippedCount = ctx.entityJudgments.reduce(
          (n, e) => n + e.pointJudgments.filter((p) => p.judgment === 'skipped').length,
          0,
        );
        return JSON.stringify({
          entityCount: ctx.entityJudgments.length,
          newPoints: newCount,
          skippedPoints: skippedCount,
        });
      }
      case 'verifying':
        return JSON.stringify({
          rejectionCount: ctx.verifierRejections.length,
          rejections: ctx.verifierRejections.map((r) => ({
            pointKey: r.pointKey,
            reason: truncate(r.reason, 80, '...'),
          })),
        });
      case 'validatePipelineOutput':
        return JSON.stringify({
          validEntityCount: ctx.validationResult?.validEntities.length ?? 0,
          droppedPointCount: ctx.validationResult?.droppedPoints.length ?? 0,
          warnings: ctx.validationResult?.warnings ?? [],
        });
      case 'translating':
        return JSON.stringify({
          translationCount: Object.keys(ctx.translations ?? {}).length,
        });
      case 'storing': {
        const pr = ctx.processingResult;
        if (!pr) return JSON.stringify({ stored: true });
        return JSON.stringify({
          accepted: pr.stats.accepted,
          skipped: pr.stats.skipped,
          dropped: pr.stats.droppedUnassigned,
          entityCount: pr.entities.length,
        });
      }
      default:
        return undefined;
    }
  } catch (err) {
    logger.debug('summarizeOutput serialization failed', {
      step,
      error: errorMessage(err),
    });
    return undefined;
  }
}
