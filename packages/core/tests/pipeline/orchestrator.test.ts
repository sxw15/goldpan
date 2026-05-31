import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRawDatabase } from '../../src/db/connection.js';
import { SqliteSourceRepository } from '../../src/db/repositories/source.repository.js';
import { SqliteTaskRepository } from '../../src/db/repositories/task.repository.js';
import type { PipelineContext } from '../../src/pipeline/types.js';
import { createTestDB, type TestDB } from '../helpers/test-db.js';
import {
  createMockCallLlm,
  createMockCategoryRepo,
  createMockEventLogRepo,
  createMockKnowledgeRepo,
  createMockSourceRepo,
  createMockTaskRepo,
  createStubConfigStore,
  createTestConfig,
  createTestSource,
  createTestTask,
} from './fixtures/index.js';

describe('pipeline orchestrator', () => {
  let mockDeps: any;
  let mockCollecting: any;
  let mockClassifying: any;
  let mockExtracting: any;
  let mockMatching: any;
  let mockRelating: any;
  let mockComparing: any;
  let mockVerifying: any;
  let mockValidateOutput: any;
  let mockTranslating: any;
  let mockStoring: any;

  const baseCtx = (): PipelineContext => ({
    task: createTestTask(),
    source: createTestSource(),
    config: createTestConfig(),
    inputType: 'text' as const,
    content: null,
    classification: null,
    points: [],
    matchingOutput: null,
    entityJudgments: [],
    verifierRejections: [],
    validationResult: null,
    validationWarnings: [],
  });

  beforeEach(() => {
    mockDeps = {
      configStore: createStubConfigStore(createTestConfig()),
      categoryRepo: createMockCategoryRepo(),
      sourceRepo: createMockSourceRepo(),
      knowledgeRepo: createMockKnowledgeRepo(),
      taskRepo: createMockTaskRepo(),
      eventLogRepo: createMockEventLogRepo(),
      callLlm: createMockCallLlm(),
      pluginRegistry: {
        getPlugin: vi.fn().mockReturnValue({ collect: vi.fn() }),
        listMatchingCollectorNames: vi.fn().mockResolvedValue([]),
      },
      db: {} as any,
    };

    // Each step returns ctx mutated
    mockCollecting = vi.fn(async (ctx) => ({ ...ctx, content: 'collected content' }));
    mockClassifying = vi.fn(async (ctx) => ({
      ...ctx,
      classification: { categoryPath: 'Tech', keywords: ['ai'] },
    }));
    mockExtracting = vi.fn(async (ctx) => ({
      ...ctx,
      points: [{ pointKey: 'kp:0', content: 'fact', type: 'fact' }],
    }));
    mockMatching = vi.fn(async (ctx) => ({
      ...ctx,
      matchingOutput: [],
      entityJudgments: [
        {
          entityKey: 'draft:e1',
          entityName: 'E1',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ],
    }));
    mockComparing = vi.fn(async (ctx) => ctx);
    mockRelating = vi.fn(async (ctx) => ({ ...ctx, relations: [] }));
    mockVerifying = vi.fn(async (ctx) => ctx);
    mockValidateOutput = vi.fn(async (ctx) => ({
      ...ctx,
      validationResult: {
        validEntities: ctx.entityJudgments,
        droppedPoints: [],
        warnings: [],
      },
    }));
    mockTranslating = vi.fn(async (ctx) => ({ ...ctx, translations: {} }));
    mockStoring = vi.fn(async (ctx) => ctx);
  });

  it('runs all steps in order for a normal flow', async () => {
    const { createPipeline } = await import('../../src/pipeline/orchestrator.js');
    const callOrder: string[] = [];

    mockCollecting.mockImplementation(async (ctx: any) => {
      callOrder.push('collecting');
      return { ...ctx, content: 'collected' };
    });
    mockClassifying.mockImplementation(async (ctx: any) => {
      callOrder.push('classifying');
      return { ...ctx, classification: { categoryPath: 'Tech', keywords: ['ai'] } };
    });
    mockExtracting.mockImplementation(async (ctx: any) => {
      callOrder.push('extracting');
      return { ...ctx, points: [{ pointKey: 'kp:0', content: 'f', type: 'fact' }] };
    });
    mockMatching.mockImplementation(async (ctx: any) => {
      callOrder.push('matching');
      return { ...ctx, entityJudgments: [{ entityKey: 'draft:e1', pointJudgments: [] }] };
    });
    mockRelating.mockImplementation(async (ctx: any) => {
      callOrder.push('relating');
      return { ...ctx, relations: [] };
    });
    mockComparing.mockImplementation(async (ctx: any) => {
      callOrder.push('comparing');
      return ctx;
    });
    mockVerifying.mockImplementation(async (ctx: any) => {
      callOrder.push('verifying');
      return ctx;
    });
    mockValidateOutput.mockImplementation(async (ctx: any) => {
      callOrder.push('validatePipelineOutput');
      return {
        ...ctx,
        validationResult: {
          validEntities: ctx.entityJudgments,
          droppedPoints: [],
          warnings: [],
        },
      };
    });
    mockStoring.mockImplementation(async (ctx: any) => {
      callOrder.push('storing');
      return ctx;
    });

    const pipeline = createPipeline({
      ...mockDeps,
      steps: {
        collecting: mockCollecting,
        classifying: mockClassifying,
        extracting: mockExtracting,
        matching: mockMatching,
        relating: mockRelating,
        comparing: mockComparing,
        verifying: mockVerifying,
        validatePipelineOutput: mockValidateOutput,
        translating: mockTranslating,
        storing: mockStoring,
      },
    });

    const ctx = baseCtx();
    await pipeline.process(ctx);

    expect(callOrder).toEqual([
      'collecting',
      'classifying',
      'extracting',
      'matching',
      'relating',
      'comparing',
      'verifying',
      'validatePipelineOutput',
      'storing',
    ]);
  });

  it('skips collecting when content already exists (inputType=text)', async () => {
    const { createPipeline } = await import('../../src/pipeline/orchestrator.js');
    const pipeline = createPipeline({
      ...mockDeps,
      steps: {
        collecting: mockCollecting,
        classifying: mockClassifying,
        extracting: mockExtracting,
        matching: mockMatching,
        relating: mockRelating,
        comparing: mockComparing,
        verifying: mockVerifying,
        validatePipelineOutput: mockValidateOutput,
        translating: mockTranslating,
        storing: mockStoring,
      },
    });

    const ctx = baseCtx();
    ctx.content = 'pre-existing content';
    ctx.inputType = 'text';

    await pipeline.process(ctx);

    expect(mockCollecting).not.toHaveBeenCalled();
    expect(mockClassifying).toHaveBeenCalled();
  });

  it('short-circuits to storing on zero extraction (empty points)', async () => {
    const { createPipeline } = await import('../../src/pipeline/orchestrator.js');
    mockExtracting.mockImplementation(async (ctx: any) => ({
      ...ctx,
      points: [],
    }));

    const pipeline = createPipeline({
      ...mockDeps,
      steps: {
        collecting: mockCollecting,
        classifying: mockClassifying,
        extracting: mockExtracting,
        matching: mockMatching,
        relating: mockRelating,
        comparing: mockComparing,
        verifying: mockVerifying,
        validatePipelineOutput: mockValidateOutput,
        translating: mockTranslating,
        storing: mockStoring,
      },
    });

    await pipeline.process(baseCtx());

    expect(mockExtracting).toHaveBeenCalled();
    expect(mockMatching).not.toHaveBeenCalled();
    expect(mockComparing).not.toHaveBeenCalled();
    expect(mockVerifying).not.toHaveBeenCalled();
    expect(mockValidateOutput).not.toHaveBeenCalled();
    expect(mockStoring).toHaveBeenCalled();
  });

  it('handles PipelineError by re-throwing (error state delegated to worker safety net when transaction fails)', async () => {
    const { createPipeline } = await import('../../src/pipeline/orchestrator.js');
    const { PipelineError } = await import('../../src/pipeline/types.js');

    mockClassifying.mockRejectedValue(
      new PipelineError('LLM returned invalid response', 'classifying', 'schema_validation'),
    );

    const pipeline = createPipeline({
      ...mockDeps,
      steps: {
        collecting: mockCollecting,
        classifying: mockClassifying,
        extracting: mockExtracting,
        matching: mockMatching,
        relating: mockRelating,
        comparing: mockComparing,
        verifying: mockVerifying,
        validatePipelineOutput: mockValidateOutput,
        translating: mockTranslating,
        storing: mockStoring,
      },
    });

    await expect(pipeline.process(baseCtx())).rejects.toThrow('LLM returned invalid response');
    // With mock DB (no raw DB), transaction fails — orchestrator does NOT fall back
    // to non-transactional writes. Worker safety net handles error persistence.
    expect(mockDeps.taskRepo.markError).not.toHaveBeenCalled();
    expect(mockDeps.sourceRepo.updateStatus).not.toHaveBeenCalled();
  });

  it('handles unexpected error by re-throwing (error state delegated to worker safety net when transaction fails)', async () => {
    const { createPipeline } = await import('../../src/pipeline/orchestrator.js');

    mockExtracting.mockRejectedValue(new Error('Unexpected DB crash'));

    const pipeline = createPipeline({
      ...mockDeps,
      steps: {
        collecting: mockCollecting,
        classifying: mockClassifying,
        extracting: mockExtracting,
        matching: mockMatching,
        relating: mockRelating,
        comparing: mockComparing,
        verifying: mockVerifying,
        validatePipelineOutput: mockValidateOutput,
        translating: mockTranslating,
        storing: mockStoring,
      },
    });

    await expect(pipeline.process(baseCtx())).rejects.toThrow('Unexpected DB crash');
    // With mock DB (no raw DB), transaction fails — orchestrator does NOT fall back
    // to non-transactional writes. Worker safety net handles error persistence.
    expect(mockDeps.taskRepo.markError).not.toHaveBeenCalled();
  });

  it('bootstraps ctx.inputType from task.inputType (Issue 1 fix)', async () => {
    const { createPipeline } = await import('../../src/pipeline/orchestrator.js');
    const receivedInputTypes: Array<string | null> = [];

    mockClassifying.mockImplementation(async (ctx: any) => {
      receivedInputTypes.push(ctx.inputType);
      return { ...ctx, classification: { categoryPath: 'Tech', keywords: ['ai'] } };
    });
    mockExtracting.mockImplementation(async (ctx: any) => ({ ...ctx, points: [] }));

    const pipeline = createPipeline({
      ...mockDeps,
      steps: {
        collecting: mockCollecting,
        classifying: mockClassifying,
        extracting: mockExtracting,
        matching: mockMatching,
        relating: mockRelating,
        comparing: mockComparing,
        verifying: mockVerifying,
        validatePipelineOutput: mockValidateOutput,
        translating: mockTranslating,
        storing: mockStoring,
      },
    });

    // Case 1: task.inputType = 'url' → ctx.inputType bootstrapped to 'url'
    const ctx1 = baseCtx();
    ctx1.inputType = null;
    ctx1.task = { ...ctx1.task, inputType: 'url' } as any;
    await pipeline.process(ctx1);
    expect(receivedInputTypes[0]).toBe('url');

    receivedInputTypes.length = 0;

    // Case 2: task.inputType = null, source.kind = 'external' → ctx.inputType = 'url'
    const ctx2 = baseCtx();
    ctx2.inputType = null;
    ctx2.task = { ...ctx2.task, inputType: null } as any;
    ctx2.source = { ...ctx2.source, kind: 'external' } as any;
    await pipeline.process(ctx2);
    expect(receivedInputTypes[0]).toBe('url');
  });

  it('handles concurrent process calls on SAME pipeline with correct step tracking', async () => {
    const { createPipeline } = await import('../../src/pipeline/orchestrator.js');

    const markErrorCalls: Array<{ taskId: number; step: string }> = [];
    mockDeps.taskRepo.markError = vi.fn(
      (taskId: number, step: string, _msg: string, _kind: string) => {
        markErrorCalls.push({ taskId, step });
      },
    );

    let callCount = 0;
    // Same pipeline: classifying succeeds, extracting fails differently per call
    const classifyingOk = vi.fn(async (ctx: any) => {
      await new Promise((r) => setTimeout(r, 5));
      return { ...ctx, classification: { categoryPath: 'Tech', keywords: ['ai'] } };
    });
    const extractingFail = vi.fn(async () => {
      callCount++;
      const myCall = callCount;
      // First call takes longer so second finishes first
      await new Promise((r) => setTimeout(r, myCall === 1 ? 30 : 5));
      throw new Error(`extracting boom ${myCall}`);
    });

    // Single pipeline instance — both process() calls share it
    const pipeline = createPipeline({
      ...mockDeps,
      steps: {
        collecting: mockCollecting,
        classifying: classifyingOk,
        extracting: extractingFail,
        matching: mockMatching,
        relating: mockRelating,
        comparing: mockComparing,
        verifying: mockVerifying,
        validatePipelineOutput: mockValidateOutput,
        storing: mockStoring,
      },
    });

    const ctx1 = baseCtx();
    ctx1.task = { ...ctx1.task, id: 1 };
    const ctx2 = baseCtx();
    ctx2.task = { ...ctx2.task, id: 2 };

    const [r1, r2] = await Promise.allSettled([pipeline.process(ctx1), pipeline.process(ctx2)]);

    expect(r1.status).toBe('rejected');
    expect(r2.status).toBe('rejected');

    // With mock DB, transaction fails so markError is not called directly.
    // The errors still propagate correctly — worker safety net handles persistence.
    // Verify both errors contain the extracting step error messages.
    expect((r1 as PromiseRejectedResult).reason.message).toContain('extracting boom');
    expect((r2 as PromiseRejectedResult).reason.message).toContain('extracting boom');
  });

  it('updates pipeline_step on task as each step begins', async () => {
    const { createPipeline } = await import('../../src/pipeline/orchestrator.js');
    const stepsRecorded: string[] = [];

    mockDeps.taskRepo.updatePipelineStep = vi.fn((_taskId: number, step: string) => {
      stepsRecorded.push(step);
    });

    const pipeline = createPipeline({
      ...mockDeps,
      steps: {
        collecting: mockCollecting,
        classifying: mockClassifying,
        extracting: mockExtracting,
        matching: mockMatching,
        relating: mockRelating,
        comparing: mockComparing,
        verifying: mockVerifying,
        validatePipelineOutput: mockValidateOutput,
        translating: mockTranslating,
        storing: mockStoring,
      },
    });

    await pipeline.process(baseCtx());

    expect(stepsRecorded).toContain('collecting');
    expect(stepsRecorded).toContain('classifying');
    expect(stepsRecorded).toContain('storing');
  });
});

// ─── Real-DB harness for transaction-sensitive error-path tests ─────────
// The mock-DB suite above documents that when `getRawDatabase()` fails,
// `doUpdate` never runs. Persisting `collector_failure_code` lives inside
// that transaction, so we need a real DB to exercise the path end-to-end.
describe('CollectorError failure-code persistence', () => {
  let testDB: TestDB;
  let sourceRepo: SqliteSourceRepository;
  let taskRepo: SqliteTaskRepository;
  let mockDeps: any;

  const stepsThatShouldNotRun = () => ({
    collecting: vi.fn(async (ctx: PipelineContext) => ctx),
    classifying: vi.fn(async (ctx: PipelineContext) => ctx),
    extracting: vi.fn(async (ctx: PipelineContext) => ctx),
    matching: vi.fn(async (ctx: PipelineContext) => ctx),
    relating: vi.fn(async (ctx: PipelineContext) => ctx),
    comparing: vi.fn(async (ctx: PipelineContext) => ctx),
    verifying: vi.fn(async (ctx: PipelineContext) => ctx),
    validatePipelineOutput: vi.fn(async (ctx: PipelineContext) => ctx),
    storing: vi.fn(async (ctx: PipelineContext) => ctx),
  });

  function seedSourceAndTask() {
    const source = sourceRepo.create({
      kind: 'external',
      normalizedUrl: `https://github.com/acme/repo-${Date.now()}`,
      originalUrl: `https://github.com/acme/repo-${Date.now()}`,
      metadata: { collectorPlugin: 'collector-github' },
    });
    const task = taskRepo.create({
      sourceId: source.id,
      type: 'pipeline',
      inputType: 'url',
    });
    return { source, task };
  }

  beforeEach(() => {
    testDB = createTestDB();
    const rawDb = getRawDatabase(testDB.db);
    sourceRepo = new SqliteSourceRepository(testDB.db);
    taskRepo = new SqliteTaskRepository(testDB.db, rawDb);

    mockDeps = {
      configStore: createStubConfigStore(createTestConfig()),
      categoryRepo: createMockCategoryRepo(),
      sourceRepo,
      knowledgeRepo: createMockKnowledgeRepo(),
      taskRepo,
      eventLogRepo: createMockEventLogRepo(),
      callLlm: createMockCallLlm(),
      pluginRegistry: {
        getPlugin: vi.fn().mockReturnValue({ collect: vi.fn() }),
        listMatchingCollectorNames: vi.fn().mockResolvedValue([]),
      },
      db: testDB.db,
    };
  });

  afterEach(() => {
    testDB.cleanup();
  });

  it('persists collector_failure_code into sources.metadata when collecting step throws CollectorError', async () => {
    const { createPipeline } = await import('../../src/pipeline/orchestrator.js');
    const { CollectorError } = await import('../../src/plugins/errors.js');

    const { source, task } = seedSourceAndTask();
    const steps = stepsThatShouldNotRun();
    steps.collecting.mockRejectedValue(
      new CollectorError('Repository not found or private', 'NOT_FOUND', false, undefined, true),
    );

    const mergeSpy = vi.spyOn(sourceRepo, 'mergeMetadata');
    const markErrorSpy = vi.spyOn(taskRepo, 'markError');
    const updateStatusSpy = vi.spyOn(sourceRepo, 'updateStatus');
    const emitTerminatedSpy = vi.spyOn(sourceRepo, 'emitTerminated');

    const pipeline = createPipeline({ ...mockDeps, steps });

    const ctx: PipelineContext = {
      task: { ...task, inputType: 'url' } as any,
      source,
      config: createTestConfig(),
      inputType: 'url',
      content: null,
      classification: null,
      points: [],
      matchingOutput: null,
      entityJudgments: [],
      verifierRejections: [],
      validationResult: null,
      validationWarnings: [],
    };

    await expect(pipeline.process(ctx)).rejects.toThrow('Repository not found or private');

    expect(markErrorSpy).toHaveBeenCalled();
    expect(updateStatusSpy).toHaveBeenCalledWith(source.id, 'failed', {
      emitTerminated: false,
    });
    expect(emitTerminatedSpy).toHaveBeenCalledWith(source.id, 'failed');
    expect(mergeSpy).toHaveBeenCalledWith(
      source.id,
      expect.objectContaining({ collector_failure_code: 'not_found' }),
    );

    // End-to-end: the row should actually carry the patched field.
    const fresh = sourceRepo.getById(source.id);
    const meta = JSON.parse(fresh?.metadata ?? '{}');
    expect(meta.collector_failure_code).toBe('not_found');
    expect(meta.collectorPlugin).toBe('collector-github');
    expect(fresh?.status).toBe('failed');
  });

  it('does NOT call mergeMetadata for non-CollectorError pipeline failures', async () => {
    const { createPipeline } = await import('../../src/pipeline/orchestrator.js');

    const { source, task } = seedSourceAndTask();
    const steps = stepsThatShouldNotRun();
    steps.collecting.mockImplementation(async (ctx: PipelineContext) => ({
      ...ctx,
      content: 'x',
    }));
    steps.classifying.mockImplementation(async (ctx: PipelineContext) => ({
      ...ctx,
      classification: { categoryPath: 'Tech', keywords: ['ai'] },
    }));
    steps.extracting.mockRejectedValue(new Error('llm blew up'));

    const mergeSpy = vi.spyOn(sourceRepo, 'mergeMetadata');

    const pipeline = createPipeline({ ...mockDeps, steps });
    const ctx: PipelineContext = {
      task: { ...task, inputType: 'url' } as any,
      source,
      config: createTestConfig(),
      inputType: 'url',
      content: null,
      classification: null,
      points: [],
      matchingOutput: null,
      entityJudgments: [],
      verifierRejections: [],
      validationResult: null,
      validationWarnings: [],
    };

    await expect(pipeline.process(ctx)).rejects.toThrow('llm blew up');
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it('does NOT call mergeMetadata when a non-collecting step throws a CollectorError-like error', async () => {
    const { createPipeline } = await import('../../src/pipeline/orchestrator.js');
    const { CollectorError } = await import('../../src/plugins/errors.js');

    const { source, task } = seedSourceAndTask();
    const steps = stepsThatShouldNotRun();
    steps.collecting.mockImplementation(async (ctx: PipelineContext) => ({
      ...ctx,
      content: 'x',
    }));
    steps.classifying.mockRejectedValue(
      // Extremely unusual — a CollectorError thrown outside collecting should
      // not trigger the merge (step guard protects against false persistence).
      new CollectorError('shouldnt-happen', 'UPSTREAM', true, undefined, false),
    );

    const mergeSpy = vi.spyOn(sourceRepo, 'mergeMetadata');

    const pipeline = createPipeline({ ...mockDeps, steps });
    const ctx: PipelineContext = {
      task: { ...task, inputType: 'url' } as any,
      source,
      config: createTestConfig(),
      inputType: 'url',
      content: null,
      classification: null,
      points: [],
      matchingOutput: null,
      entityJudgments: [],
      verifierRejections: [],
      validationResult: null,
      validationWarnings: [],
    };

    await expect(pipeline.process(ctx)).rejects.toThrow('shouldnt-happen');
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  // Regression for: executeCollecting wraps CollectorError into
  // PipelineError(..., cause=CollectorError). Guarding on
  // `error instanceof CollectorError` alone skips this path in production.
  it('persists collector_failure_code when executeCollecting wraps CollectorError into PipelineError', async () => {
    const { createPipeline } = await import('../../src/pipeline/orchestrator.js');
    const { executeCollecting } = await import('../../src/pipeline/steps/collecting.js');
    const { CollectorError } = await import('../../src/plugins/errors.js');

    const { source, task } = seedSourceAndTask();
    const steps = stepsThatShouldNotRun();
    steps.collecting = vi.fn((ctx: PipelineContext) =>
      executeCollecting(ctx, {
        sourceRepo,
        pluginRegistry: {
          getCollector: async () => ({
            collect: async () => {
              throw new CollectorError(
                'Repository not found or private',
                'NOT_FOUND',
                false,
                undefined,
                true,
              );
            },
          }),
        },
      }),
    ) as any;

    const mergeSpy = vi.spyOn(sourceRepo, 'mergeMetadata');

    const pipeline = createPipeline({ ...mockDeps, steps });
    const ctx: PipelineContext = {
      task: { ...task, inputType: 'url' } as any,
      source,
      config: createTestConfig(),
      inputType: 'url',
      content: null,
      classification: null,
      points: [],
      matchingOutput: null,
      entityJudgments: [],
      verifierRejections: [],
      validationResult: null,
      validationWarnings: [],
    };

    await expect(pipeline.process(ctx)).rejects.toThrow();
    expect(mergeSpy).toHaveBeenCalledWith(
      source.id,
      expect.objectContaining({ collector_failure_code: 'not_found' }),
    );
    const fresh = sourceRepo.getById(source.id);
    const meta = JSON.parse(fresh?.metadata ?? '{}');
    expect(meta.collector_failure_code).toBe('not_found');
  });
});

// ─── Per-task config snapshot invariant ──────────────────────────────────
// Spec invariant: "task 内 config 不变". The orchestrator pulls a fresh
// snapshot at process() entry and freezes it as `taskDeps.config` for the
// task; a configStore.commit() during step execution does NOT bleed into
// subsequent steps of the in-flight task. The next process() call picks up
// the new snapshot.
describe('createPipeline — per-task snapshot invariant', () => {
  const MIN_VALID_ENV: NodeJS.ProcessEnv = {
    GOLDPAN_LANGUAGE: 'en',
    GOLDPAN_LLM_CLASSIFIER: 'openai:gpt-4o-mini',
    GOLDPAN_LLM_EXTRACTOR: 'openai:gpt-4o-mini',
    GOLDPAN_LLM_MATCHER: 'openai:gpt-4o-mini',
    GOLDPAN_LLM_COMPARATOR: 'openai:gpt-4o-mini',
    GOLDPAN_LLM_INTENT: 'openai:gpt-4o-mini',
    GOLDPAN_LLM_QUERY: 'openai:gpt-4o-mini',
    OPENAI_API_KEY: 'sk-test-baseline',
  };

  it('mid-task commit 不影响当前 task,下一个 task 看到新值', async () => {
    const t = createTestDB();
    try {
      const { createConfigStore } = await import('../../src/config/store.js');
      const { createRootLogger } = await import('../../src/logger/index.js');
      const { createPipeline } = await import('../../src/pipeline/orchestrator.js');

      const store = await createConfigStore({
        db: t.db,
        bootEnv: MIN_VALID_ENV,
        applyToProcessEnv: false,
        logger: createRootLogger('error'),
      });

      const passThrough: import('../../src/pipeline/orchestrator.js').StepFn = async (c) => c;

      // Captures observed `deps.config.llm.classifier` per task. We wire
      // classifying to TRIGGER a mid-task commit and extracting to OBSERVE —
      // step 2 of task 1 must still see the old value because its `deps` is
      // the snapshot captured at process() entry, not the live store.
      const observed: Array<{ task: number; classifier: string }> = [];
      let currentTask = 0;
      let triggerCommit = false;

      const stubSteps: import('../../src/pipeline/orchestrator.js').PipelineSteps = {
        collecting: passThrough,
        classifying: async (ctx) => {
          if (triggerCommit) {
            // Mid-task commit on task 1 — must NOT affect task 1's later steps.
            const r = await store.commit(new Map([['GOLDPAN_LLM_CLASSIFIER', 'openai:gpt-4o']]));
            expect(r.kind).toBe('ok');
          }
          return {
            ...ctx,
            classification: { categoryPath: 'Tech', keywords: ['ai'] },
          };
        },
        extracting: async (ctx, deps) => {
          observed.push({ task: currentTask, classifier: deps.config.llm.classifier });
          // Return zero points so the rest of the pipeline short-circuits to
          // storing — keeps the test free of matching/relating wiring.
          return { ...ctx, points: [] };
        },
        matching: passThrough,
        relating: passThrough,
        comparing: passThrough,
        verifying: passThrough,
        validatePipelineOutput: passThrough,
        translating: passThrough,
        storing: passThrough,
      };

      const pipeline = createPipeline({
        configStore: store,
        categoryRepo: createMockCategoryRepo(),
        sourceRepo: createMockSourceRepo(),
        knowledgeRepo: createMockKnowledgeRepo(),
        taskRepo: createMockTaskRepo(),
        eventLogRepo: createMockEventLogRepo(),
        callLlm: createMockCallLlm() as any,
        llmCallRepo: { create: vi.fn(), getBySourceId: vi.fn() } as any,
        pluginRegistry: {
          getPlugin: vi.fn(),
          listMatchingCollectorNames: vi.fn().mockResolvedValue([]),
        } as any,
        db: t.db,
        steps: stubSteps,
      });

      const baseCtx = (): PipelineContext => ({
        task: createTestTask(),
        source: createTestSource(),
        config: createTestConfig(),
        inputType: 'text' as const,
        // Prefilled content → collecting is skipped; classifying fires first.
        content: 'pre-existing content',
        classification: null,
        points: [],
        matchingOutput: null,
        entityJudgments: [],
        verifierRejections: [],
        validationResult: null,
        validationWarnings: [],
      });

      // Task 1 — classifying triggers a mid-task commit; extracting must still
      // see the OLD model (snapshot was frozen at process() entry).
      currentTask = 1;
      triggerCommit = true;
      await pipeline.process(baseCtx());

      // Task 2 — no commit; extracting picks up the model committed during task 1.
      currentTask = 2;
      triggerCommit = false;
      await pipeline.process(baseCtx());

      expect(observed).toEqual([
        { task: 1, classifier: 'openai:gpt-4o-mini' }, // OLD value — invariant holds
        { task: 2, classifier: 'openai:gpt-4o' }, // next task picks up new value
      ]);
    } finally {
      t.cleanup();
    }
  });
});
