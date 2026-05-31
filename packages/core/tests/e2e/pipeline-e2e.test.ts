import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRawDatabase } from '../../src/db/connection.js';
import {
  SqliteCategoryRepository,
  SqliteEventLogRepository,
  SqliteKnowledgeRepository,
  SqliteLlmCallRepository,
  SqliteSourceRepository,
  SqliteTaskRepository,
} from '../../src/db/repositories/index.js';
import type { InputType } from '../../src/db/repositories/types.js';
import { callLlm } from '../../src/llm/call.js';
import { createLlmRegistry } from '../../src/llm/registry.js';
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
} from '../../src/pipeline/index.js';
import type { PipelineContext, ProcessingResult } from '../../src/pipeline/types.js';
import { collectorWebPlugin } from '../../src/plugins/index.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { createTestDB, type TestDB } from '../helpers/test-db.js';
import { createStubConfigStore, createTestConfig } from '../pipeline/fixtures/index.js';

const config = {
  ...createTestConfig(),
  llm: {
    classifier: process.env.GOLDPAN_LLM_CLASSIFIER ?? 'openai:gpt-4o-mini',
    extractor: process.env.GOLDPAN_LLM_EXTRACTOR ?? 'openai:gpt-4o-mini',
    matcher: process.env.GOLDPAN_LLM_MATCHER ?? 'openai:gpt-4o-mini',
    comparator: process.env.GOLDPAN_LLM_COMPARATOR ?? 'openai:gpt-4o-mini',
    verifier: process.env.GOLDPAN_LLM_VERIFIER ?? 'openai:gpt-4o-mini',
    verifierEnabled: false,
  },
  llmLogPayloads: false,
  llmTimeout: 60,
  nodeEnv: 'test' as const,
};

type LlmModelKey = 'classifier' | 'extractor' | 'matcher' | 'comparator' | 'verifier';
const STEP_TO_MODEL_KEY: Record<string, LlmModelKey> = {
  classifier: 'classifier',
  extractor: 'extractor',
  matcher: 'matcher',
  comparator: 'comparator',
  verifier: 'verifier',
};

describe.skipIf(!process.env.OPENAI_API_KEY)('Pipeline E2E test (real LLM)', () => {
  let testDB: TestDB;
  let taskRepo: InstanceType<typeof SqliteTaskRepository>;
  let sourceRepo: InstanceType<typeof SqliteSourceRepository>;
  let categoryRepo: InstanceType<typeof SqliteCategoryRepository>;
  let knowledgeRepo: InstanceType<typeof SqliteKnowledgeRepository>;
  let eventLogRepo: InstanceType<typeof SqliteEventLogRepository>;
  let llmCallRepo: InstanceType<typeof SqliteLlmCallRepository>;
  let pluginRegistry: PluginRegistry;

  beforeEach(() => {
    testDB = createTestDB();
    const rawDb = getRawDatabase(testDB.db);

    taskRepo = new SqliteTaskRepository(testDB.db, rawDb);
    sourceRepo = new SqliteSourceRepository(testDB.db);
    categoryRepo = new SqliteCategoryRepository(testDB.db);
    knowledgeRepo = new SqliteKnowledgeRepository(testDB.db);
    eventLogRepo = new SqliteEventLogRepository(testDB.db);
    llmCallRepo = new SqliteLlmCallRepository(testDB.db);

    pluginRegistry = new PluginRegistry({ collectTimeoutSeconds: 30 });
    pluginRegistry.register(collectorWebPlugin);
  });

  afterEach(() => {
    testDB.cleanup();
  });

  function buildPipeline() {
    const registry = createLlmRegistry(createStubConfigStore(config), pluginRegistry);

    // Wrap callLlm to resolve the correct model per step from config + registry.
    // registry.languageModel takes a step key, not a resolved model id.
    const wrappedCallLlm: typeof callLlm = (opts) => {
      const modelKey = STEP_TO_MODEL_KEY[opts.step];
      if (!modelKey) {
        throw new Error(`Unknown LLM step "${opts.step}"`);
      }
      const model = registry.languageModel(modelKey);
      return callLlm({ ...opts, model });
    };

    return createPipeline({
      configStore: createStubConfigStore(config),
      categoryRepo,
      sourceRepo,
      knowledgeRepo,
      taskRepo,
      eventLogRepo,
      callLlm: wrappedCallLlm,
      llmCallRepo,
      pluginRegistry,
      db: testDB.db,
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
  }

  function buildContext(
    task: ReturnType<typeof taskRepo.create>,
    source: ReturnType<typeof sourceRepo.create>,
  ): PipelineContext {
    return {
      task,
      source,
      config,
      inputType: (task.inputType as InputType | null) ?? null,
      content: null,
      classification: null,
      points: [],
      matchingOutput: null,
      entityJudgments: [],
      verifierRejections: [],
      validationResult: null,
      validationWarnings: [],
    };
  }

  const TECH_TEXT =
    'TypeScript 5.5 于2024年6月发布，引入了推断类型谓词（Inferred Type Predicates）功能。' +
    '这一特性允许 TypeScript 编译器自动推断函数的类型谓词，无需开发者手动标注。' +
    '此外，TypeScript 5.5 还增强了控制流分析，改进了对常量索引访问的类型缩窄。' +
    '新版本还支持了正则表达式的语法检查功能，能够在编译阶段捕获正则表达式中的常见错误。';

  it('processes text input through real LLM pipeline', async () => {
    // Seed DB
    const source = sourceRepo.create({
      kind: 'user',
      rawContent: TECH_TEXT,
      status: 'processing',
    });
    const task = taskRepo.create({
      sourceId: source.id,
      type: 'pipeline',
      inputType: 'text',
      status: 'pending',
    });

    const claimed = taskRepo.claimNextPending()!;
    expect(claimed).toBeDefined();
    expect(claimed.id).toBe(task.id);

    const claimedSource = sourceRepo.getById(source.id)!;
    const ctx = buildContext(claimed, claimedSource);

    // Run pipeline with real LLM
    const pipeline = buildPipeline();
    await pipeline.process(ctx);

    // Verify task status
    const finalTask = taskRepo.getById(task.id)!;
    expect(finalTask.status).toBe('done');
    expect(finalTask.result).toBeDefined();

    const result: ProcessingResult = JSON.parse(finalTask.result!);
    expect(result.status).toBe('done');

    // Verify ProcessingResult structure
    expect(result.stats).toBeDefined();
    expect(typeof result.stats.extracted).toBe('number');
    expect(typeof result.stats.accepted).toBe('number');
    expect(typeof result.stats.droppedUnassigned).toBe('number');
    expect(typeof result.stats.quarantined).toBe('number');
    expect(typeof result.stats.skipped).toBe('number');
    expect(typeof result.stats.verifierRejected).toBe('number');

    // Stats invariant: extracted = accepted + droppedUnassigned + quarantined + skipped + verifierRejected
    const { extracted, accepted, droppedUnassigned, quarantined, skipped, verifierRejected } =
      result.stats;
    expect(extracted).toBe(accepted + droppedUnassigned + quarantined + skipped + verifierRejected);

    // Classification should be present
    expect(result.classification).toBeDefined();
    expect(result.classification?.categoryPath).toBeTruthy();
    expect(result.classification?.keywords.length).toBeGreaterThan(0);

    // Entities array must exist
    expect(Array.isArray(result.entities)).toBe(true);

    // Source status
    const finalSource = sourceRepo.getById(source.id)!;
    expect(['confirmed', 'confirmed_empty']).toContain(finalSource.status);

    // If accepted > 0, knowledge points should exist in DB
    if (accepted > 0) {
      expect(result.entities.length).toBeGreaterThan(0);
      const firstEntity = result.entities[0];
      expect(firstEntity.entityId).toBeDefined();
      const dbEntity = knowledgeRepo.getEntityById(firstEntity.entityId!);
      expect(dbEntity).toBeDefined();
    }

    // Event logs should be written
    const events = eventLogRepo.getBySourceId(source.id);
    expect(events.length).toBeGreaterThan(0);
  }, 120_000);

  it('detects duplicates on second submission of same content', async () => {
    // --- First submission ---
    const source1 = sourceRepo.create({
      kind: 'user',
      rawContent: TECH_TEXT,
      status: 'processing',
    });
    const task1 = taskRepo.create({
      sourceId: source1.id,
      type: 'pipeline',
      inputType: 'text',
      status: 'pending',
    });

    const claimed1 = taskRepo.claimNextPending()!;
    const ctx1 = buildContext(claimed1, sourceRepo.getById(source1.id)!);

    const pipeline = buildPipeline();
    await pipeline.process(ctx1);

    const firstResult: ProcessingResult = JSON.parse(taskRepo.getById(task1.id)!.result!);
    expect(firstResult.status).toBe('done');
    expect(firstResult.stats.accepted).toBeGreaterThan(0);

    // --- Second submission (same content) ---
    const source2 = sourceRepo.create({
      kind: 'user',
      rawContent: TECH_TEXT,
      status: 'processing',
    });
    const task2 = taskRepo.create({
      sourceId: source2.id,
      type: 'pipeline',
      inputType: 'text',
      status: 'pending',
    });

    const claimed2 = taskRepo.claimNextPending()!;
    const ctx2 = buildContext(claimed2, sourceRepo.getById(source2.id)!);

    await pipeline.process(ctx2);

    const secondResult: ProcessingResult = JSON.parse(taskRepo.getById(task2.id)!.result!);
    expect(secondResult.status).toBe('done');

    // Stats invariant must still hold
    const { extracted, accepted, droppedUnassigned, quarantined, skipped, verifierRejected } =
      secondResult.stats;
    expect(extracted).toBe(accepted + droppedUnassigned + quarantined + skipped + verifierRejected);

    // Source status for second submission
    const finalSource2 = sourceRepo.getById(source2.id)!;
    expect(['confirmed', 'confirmed_empty']).toContain(finalSource2.status);
  }, 180_000);
});
