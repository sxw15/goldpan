import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { PipelineError } from '../../src/errors.js';
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
import { PluginRegistry } from '../../src/plugins/registry.js';
import { createTestDB, type TestDB } from '../helpers/test-db.js';
import { createStubConfigStore, createTestConfig } from '../pipeline/fixtures/index.js';

describe('Full Flow Integration (mocked LLM)', () => {
  let testDB: TestDB;
  let taskRepo: InstanceType<typeof SqliteTaskRepository>;
  let sourceRepo: InstanceType<typeof SqliteSourceRepository>;
  let categoryRepo: InstanceType<typeof SqliteCategoryRepository>;
  let knowledgeRepo: InstanceType<typeof SqliteKnowledgeRepository>;
  let eventLogRepo: InstanceType<typeof SqliteEventLogRepository>;
  let llmCallRepo: InstanceType<typeof SqliteLlmCallRepository>;
  let pluginRegistry: PluginRegistry;
  let mockCallLlm: ReturnType<typeof vi.fn>;
  let config: ReturnType<typeof createTestConfig>;

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

    config = createTestConfig({ llm: { verifierEnabled: false } });
    mockCallLlm = vi.fn();
  });

  afterEach(() => {
    testDB.cleanup();
  });

  function buildPipeline() {
    return createPipeline({
      configStore: createStubConfigStore(config),
      categoryRepo,
      sourceRepo,
      knowledgeRepo,
      taskRepo,
      eventLogRepo,
      callLlm: mockCallLlm,
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

  it('processes text input through full pipeline and stores knowledge points', async () => {
    // 1. Seed DB
    const source = sourceRepo.create({
      kind: 'user',
      rawContent:
        '苹果公司在2024年发布了Vision Pro头显，售价3499美元。这是苹果首款混合现实设备，搭载M2和R1芯片。',
      status: 'processing',
    });
    const task = taskRepo.create({
      sourceId: source.id,
      type: 'pipeline',
      inputType: 'text',
      status: 'pending',
    });

    // 2. Claim the task (atomic pending → processing)
    const claimed = taskRepo.claimNextPending()!;
    expect(claimed).toBeDefined();
    expect(claimed.id).toBe(task.id);

    const claimedSource = sourceRepo.getById(source.id)!;
    const ctx = buildContext(claimed, claimedSource);

    // 3. Mock callLlm responses per step
    mockCallLlm.mockImplementation((opts: { step: string }) => {
      switch (opts.step) {
        case 'classifier':
          return Promise.resolve({
            inputType: 'text' as const,
            categoryPath: 'Tech/Consumer Electronics/Apple',
            keywords: ['Apple', 'Vision Pro', 'mixed reality'],
          });
        case 'extractor':
          return Promise.resolve({
            points: [
              { content: 'Apple released the Vision Pro headset in 2024', type: 'fact' as const },
              { content: 'Vision Pro is priced at $3,499', type: 'fact' as const },
              { content: 'Vision Pro is equipped with M2 and R1 chips', type: 'fact' as const },
            ],
          });
        case 'matcher':
          return Promise.resolve({
            entities: [
              {
                entityKey: 'draft:apple-vision-pro',
                entityName: 'Apple Vision Pro',
                resolvedCategoryPath: 'Tech/Consumer Electronics/Apple',
                knowledgePointKeys: ['kp:0', 'kp:1', 'kp:2'],
                keywords: ['Apple', 'Vision Pro', 'mixed reality'],
                description: "Apple's mixed reality headset device",
              },
            ],
          });
        // Comparator won't be called for draft entities with no existing points
        case 'comparator':
          return Promise.resolve({
            pointJudgments: [
              { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
              { pointKey: 'kp:1', judgment: 'new', matchedPointId: null, matchedContent: null },
              { pointKey: 'kp:2', judgment: 'new', matchedPointId: null, matchedContent: null },
            ],
          });
        default:
          return Promise.reject(new Error(`Unexpected LLM step: ${opts.step}`));
      }
    });

    // 4. Run the pipeline
    const pipeline = buildPipeline();
    await pipeline.process(ctx);

    // 5. Verify task status = done
    const finalTask = taskRepo.getById(task.id)!;
    expect(finalTask.status).toBe('done');
    expect(finalTask.result).toBeDefined();

    const result: ProcessingResult = JSON.parse(finalTask.result!);
    expect(result.status).toBe('done');
    expect(result.stats.extracted).toBe(3);
    expect(result.stats.accepted).toBe(3);
    expect(result.stats.skipped).toBe(0);

    // 6. Verify source status = confirmed
    const finalSource = sourceRepo.getById(source.id)!;
    expect(finalSource.status).toBe('confirmed');

    // 7. Verify entities were created
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].entityName).toBe('Apple Vision Pro');
    expect(result.entities[0].isNew).toBe(true);
    expect(result.entities[0].newFactPoints).toHaveLength(3);

    // 8. Verify knowledge points persisted in DB
    const entityId = result.entities[0].entityId!;
    const dbEntity = knowledgeRepo.getEntityById(entityId);
    expect(dbEntity).toBeDefined();
    expect(dbEntity?.name).toBe('Apple Vision Pro');

    // 9. Verify event logs
    const events = eventLogRepo.getBySourceId(source.id);
    const actions = events.map((e) => e.action);
    expect(actions).toContain('entity_created');
    expect(actions).toContain('point_created');
    expect(actions).toContain('source_confirmed');
  });

  it('handles empty extraction → confirmed_empty status', async () => {
    // 1. Seed DB
    const source = sourceRepo.create({
      kind: 'user',
      rawContent:
        '今天天气很好，适合出去散步。阳光明媚，微风拂面，真是令人愉快的一天。公园里的花都开了，鸟儿在枝头歌唱。',
      status: 'processing',
    });
    const task = taskRepo.create({
      sourceId: source.id,
      type: 'pipeline',
      inputType: 'text',
      status: 'pending',
    });

    const claimed = taskRepo.claimNextPending()!;
    const claimedSource = sourceRepo.getById(source.id)!;
    const ctx = buildContext(claimed, claimedSource);

    // 2. Mock: classifier returns valid classification, extractor returns empty
    mockCallLlm.mockImplementation((opts: { step: string }) => {
      switch (opts.step) {
        case 'classifier':
          return Promise.resolve({
            inputType: 'text' as const,
            categoryPath: 'Daily/Weather',
            keywords: ['weather', 'walking'],
          });
        case 'extractor':
          return Promise.resolve({ points: [] });
        default:
          return Promise.reject(new Error(`Unexpected LLM step: ${opts.step}`));
      }
    });

    // 3. Run the pipeline
    const pipeline = buildPipeline();
    await pipeline.process(ctx);

    // 4. Verify task status = done
    const finalTask = taskRepo.getById(task.id)!;
    expect(finalTask.status).toBe('done');

    const result: ProcessingResult = JSON.parse(finalTask.result!);
    expect(result.status).toBe('done');
    expect(result.stats.extracted).toBe(0);
    expect(result.stats.accepted).toBe(0);

    // 5. Verify source status = confirmed_empty
    const finalSource = sourceRepo.getById(source.id)!;
    expect(finalSource.status).toBe('confirmed_empty');

    // 6. Verify event log has source_confirmed_empty
    const events = eventLogRepo.getBySourceId(source.id);
    const actions = events.map((e) => e.action);
    expect(actions).toContain('source_confirmed_empty');
    expect(actions).not.toContain('point_created');
  });

  it('handles pipeline error → error status + source failed', async () => {
    // 1. Seed DB
    const source = sourceRepo.create({
      kind: 'user',
      rawContent: '这是一段测试内容，用于测试错误处理。这段内容应该足够长以通过最小长度检查。',
      status: 'processing',
    });
    const task = taskRepo.create({
      sourceId: source.id,
      type: 'pipeline',
      inputType: 'text',
      status: 'pending',
    });

    const claimed = taskRepo.claimNextPending()!;
    const claimedSource = sourceRepo.getById(source.id)!;
    const ctx = buildContext(claimed, claimedSource);

    // 2. Mock: classifier throws error (use PipelineStep 'classifying' for valid DB constraint)
    mockCallLlm.mockImplementation((opts: { step: string }) => {
      if (opts.step === 'classifier') {
        return Promise.reject(
          new PipelineError('LLM rate limit exceeded', 'classifying', 'rate_limit'),
        );
      }
      return Promise.reject(new Error(`Unexpected LLM step: ${opts.step}`));
    });

    // 3. Run the pipeline — expect it to throw
    const pipeline = buildPipeline();
    await expect(pipeline.process(ctx)).rejects.toThrow(PipelineError);

    // 4. Verify task status = error
    const finalTask = taskRepo.getById(task.id)!;
    expect(finalTask.status).toBe('error');

    // 5. Verify source status = failed
    const finalSource = sourceRepo.getById(source.id)!;
    expect(finalSource.status).toBe('failed');
  });
});
