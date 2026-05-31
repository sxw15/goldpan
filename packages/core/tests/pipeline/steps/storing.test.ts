import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRawDatabase } from '../../../src/db/connection.js';
import { SqliteCategoryRepository } from '../../../src/db/repositories/category.repository.js';
import { SqliteKnowledgeRepository } from '../../../src/db/repositories/knowledge.repository.js';
import { SqliteEventLogRepository } from '../../../src/db/repositories/log.repository.js';
import { SqliteSourceRepository } from '../../../src/db/repositories/source.repository.js';
import { SqliteTaskRepository } from '../../../src/db/repositories/task.repository.js';
import * as schema from '../../../src/db/schema.js';
import type {
  EntityJudgment,
  IndexedPoint,
  PipelineContext,
  RelationOutput,
} from '../../../src/pipeline/types.js';
import { createTestDB, type TestDB } from '../../helpers/test-db.js';
import { createTestConfig } from '../fixtures/index.js';

describe('storing step (real DB)', () => {
  let t: TestDB;
  let categoryRepo: InstanceType<typeof SqliteCategoryRepository>;
  let sourceRepo: InstanceType<typeof SqliteSourceRepository>;
  let knowledgeRepo: InstanceType<typeof SqliteKnowledgeRepository>;
  let taskRepo: InstanceType<typeof SqliteTaskRepository>;
  let eventLogRepo: InstanceType<typeof SqliteEventLogRepository>;

  beforeEach(() => {
    t = createTestDB();
    categoryRepo = new SqliteCategoryRepository(t.db);
    sourceRepo = new SqliteSourceRepository(t.db);
    knowledgeRepo = new SqliteKnowledgeRepository(t.db);
    taskRepo = new SqliteTaskRepository(t.db, getRawDatabase(t.db));
    eventLogRepo = new SqliteEventLogRepository(t.db);
  });

  afterEach(() => {
    t.cleanup();
  });

  function setupSourceAndTask(): { sourceId: number; taskId: number } {
    const source = sourceRepo.create({
      kind: 'user',
      rawContent: 'Test content',
    });
    const task = taskRepo.create({
      sourceId: source.id,
      type: 'pipeline',
      inputType: 'text',
    });
    taskRepo.claimNextPending();
    return { sourceId: source.id, taskId: task.id };
  }

  function makeStoreCtx(
    sourceId: number,
    taskId: number,
    validEntities: EntityJudgment[],
    points: IndexedPoint[],
  ): PipelineContext {
    const source = sourceRepo.getById(sourceId)!;
    const task = taskRepo.getById(taskId)!;
    return {
      task,
      source,
      config: createTestConfig(),
      inputType: 'text',
      content: 'Test content',
      classification: { categoryPath: 'Tech/AI', keywords: ['AI'] },
      points,
      matchingOutput: null,
      entityJudgments: validEntities,
      verifierRejections: [],
      validationResult: {
        validEntities,
        droppedPoints: [],
        warnings: [],
      },
      validationWarnings: [],
    };
  }

  it('creates draft entity with category path and knowledge points', async () => {
    const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');
    const { sourceId, taskId } = setupSourceAndTask();

    const points: IndexedPoint[] = [{ pointKey: 'kp:0', content: 'New fact', type: 'fact' }];
    const validEntities: EntityJudgment[] = [
      {
        entityKey: 'draft:new-tool',
        entityName: 'New Tool',
        resolvedCategoryPath: 'Tech/AI/Tools',
        knowledgePointKeys: ['kp:0'],
        outputMode: 'full_summary',
        keywords: ['tool', 'ai', 'new'],
        description: 'A new AI tool',
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
        ],
      },
    ];

    const ctx = makeStoreCtx(sourceId, taskId, validEntities, points);
    await executeStoring(ctx, {
      db: t.db,
      categoryRepo,
      sourceRepo,
      knowledgeRepo,
      taskRepo,
      eventLogRepo,
    });

    const entitiesRows = t.db.select().from(schema.entities).all();
    expect(entitiesRows).toHaveLength(1);
    expect(entitiesRows[0].name).toBe('New Tool');
    expect(entitiesRows[0].description).toBe('A new AI tool');

    const kps = t.db.select().from(schema.knowledgePoints).all();
    expect(kps).toHaveLength(1);
    expect(kps[0].content).toBe('New fact');

    const seps = t.db.select().from(schema.sourceEntityPoints).all();
    expect(seps).toHaveLength(1);
    expect(seps[0].judgment).toBe('new');

    const source = sourceRepo.getById(sourceId)!;
    expect(source.status).toBe('confirmed');

    const task = taskRepo.getById(taskId)!;
    expect(task.status).toBe('done');
    expect(task.result).not.toBeNull();
  });

  it('handles cross-entity point dedup (same pointKey creates one knowledge_point)', async () => {
    const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');
    const { sourceId, taskId } = setupSourceAndTask();

    const points: IndexedPoint[] = [{ pointKey: 'kp:0', content: 'Shared fact', type: 'fact' }];
    const validEntities: EntityJudgment[] = [
      {
        entityKey: 'draft:e1',
        entityName: 'Entity A',
        resolvedCategoryPath: 'Tech',
        knowledgePointKeys: ['kp:0'],
        outputMode: 'full_summary',
        keywords: ['a', 'b', 'c'],
        description: 'Entity A',
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
        ],
      },
      {
        entityKey: 'draft:e2',
        entityName: 'Entity B',
        resolvedCategoryPath: 'Finance',
        knowledgePointKeys: ['kp:0'],
        outputMode: 'full_summary',
        keywords: ['d', 'e', 'f'],
        description: 'Entity B',
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
        ],
      },
    ];

    const ctx = makeStoreCtx(sourceId, taskId, validEntities, points);
    await executeStoring(ctx, {
      db: t.db,
      categoryRepo,
      sourceRepo,
      knowledgeRepo,
      taskRepo,
      eventLogRepo,
    });

    const kps = t.db.select().from(schema.knowledgePoints).all();
    expect(kps).toHaveLength(1);

    const seps = t.db.select().from(schema.sourceEntityPoints).all();
    expect(seps).toHaveLength(2);
  });

  it('handles mixed judgment (same pointKey: new in entity A, skipped in entity B)', async () => {
    const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');
    const { sourceId, taskId } = setupSourceAndTask();

    const existingEntity = knowledgeRepo.createEntity({ name: 'Existing Entity' });
    const existingPoint = knowledgeRepo.createPoint('Existing fact content', 'fact');
    const prevSource = sourceRepo.create({ kind: 'user', rawContent: 'prev' });
    knowledgeRepo.createSourceEntityPoint(
      prevSource.id,
      existingEntity.id,
      existingPoint.id,
      'new',
    );
    sourceRepo.updateStatus(prevSource.id, 'confirmed');

    const points: IndexedPoint[] = [
      { pointKey: 'kp:0', content: 'New fact in draft, skipped in existing', type: 'fact' },
    ];
    const validEntities: EntityJudgment[] = [
      {
        entityKey: 'draft:new-e',
        entityName: 'New E',
        resolvedCategoryPath: 'Tech',
        knowledgePointKeys: ['kp:0'],
        outputMode: 'full_summary',
        keywords: ['a', 'b', 'c'],
        description: 'New entity',
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
        ],
      },
      {
        entityKey: `entity:${existingEntity.id}`,
        entityName: existingEntity.name,
        resolvedCategoryPath: 'Tech',
        knowledgePointKeys: ['kp:0'],
        outputMode: 'full_summary',
        pointJudgments: [
          {
            pointKey: 'kp:0',
            judgment: 'skipped',
            matchedPointId: existingPoint.id,
            matchedContent: existingPoint.content,
          },
        ],
      },
    ];

    const ctx = makeStoreCtx(sourceId, taskId, validEntities, points);
    await executeStoring(ctx, {
      db: t.db,
      categoryRepo,
      sourceRepo,
      knowledgeRepo,
      taskRepo,
      eventLogRepo,
    });

    const allKps = t.db.select().from(schema.knowledgePoints).all();
    expect(allKps).toHaveLength(2);

    const seps = t.db.select().from(schema.sourceEntityPoints).all();
    expect(seps.filter((s) => s.sourceId === sourceId)).toHaveLength(2);
  });

  it('sets source status to confirmed_empty when no knowledge output', async () => {
    const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');
    const { sourceId, taskId } = setupSourceAndTask();

    const ctx = makeStoreCtx(sourceId, taskId, [], []);
    await executeStoring(ctx, {
      db: t.db,
      categoryRepo,
      sourceRepo,
      knowledgeRepo,
      taskRepo,
      eventLogRepo,
    });

    const source = sourceRepo.getById(sourceId)!;
    expect(source.status).toBe('confirmed_empty');
  });

  it('writes event logs for entity creation and point creation', async () => {
    const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');
    const { sourceId, taskId } = setupSourceAndTask();

    const points: IndexedPoint[] = [{ pointKey: 'kp:0', content: 'New fact', type: 'fact' }];
    const validEntities: EntityJudgment[] = [
      {
        entityKey: 'draft:e1',
        entityName: 'E1',
        resolvedCategoryPath: 'Tech',
        knowledgePointKeys: ['kp:0'],
        outputMode: 'full_summary',
        keywords: ['a', 'b', 'c'],
        description: 'E1 desc',
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
        ],
      },
    ];

    const ctx = makeStoreCtx(sourceId, taskId, validEntities, points);
    await executeStoring(ctx, {
      db: t.db,
      categoryRepo,
      sourceRepo,
      knowledgeRepo,
      taskRepo,
      eventLogRepo,
    });

    const events = t.db.select().from(schema.eventLogs).all();
    const actions = events.map((e) => e.action);
    expect(actions).toContain('entity_created');
    expect(actions).toContain('point_created');
    expect(actions).toContain('source_confirmed');
  });

  it('appends aliases for existing entity with discoveredAliases', async () => {
    const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');
    const { sourceId, taskId } = setupSourceAndTask();

    const existingEntity = knowledgeRepo.createEntity({ name: 'Claude Code' });
    const catId = categoryRepo.ensureCategoryPath('Tech/AI');
    knowledgeRepo.linkEntityToCategory(existingEntity.id, catId);

    const points: IndexedPoint[] = [{ pointKey: 'kp:0', content: 'New info', type: 'fact' }];
    const validEntities: EntityJudgment[] = [
      {
        entityKey: `entity:${existingEntity.id}`,
        entityName: 'Claude Code',
        resolvedCategoryPath: 'Tech/AI',
        knowledgePointKeys: ['kp:0'],
        outputMode: 'full_summary',
        discoveredAliases: ['claude-code', 'CC'],
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
        ],
      },
    ];

    const ctx = makeStoreCtx(sourceId, taskId, validEntities, points);
    await executeStoring(ctx, {
      db: t.db,
      categoryRepo,
      sourceRepo,
      knowledgeRepo,
      taskRepo,
      eventLogRepo,
    });

    const entity = knowledgeRepo.getEntityById(existingEntity.id)!;
    const aliases = JSON.parse(entity.aliases);
    expect(aliases).toContain('claude-code');
    expect(aliases).toContain('CC');
  });

  it('does NOT append aliases when all points are quarantined', async () => {
    const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');
    const { sourceId, taskId } = setupSourceAndTask();

    const existingEntity = knowledgeRepo.createEntity({ name: 'QuarantinedEntity' });
    const catId = categoryRepo.ensureCategoryPath('Tech');
    knowledgeRepo.linkEntityToCategory(existingEntity.id, catId);

    const points: IndexedPoint[] = [{ pointKey: 'kp:0', content: 'Bad point', type: 'fact' }];
    const validEntities: EntityJudgment[] = [
      {
        entityKey: `entity:${existingEntity.id}`,
        entityName: 'QuarantinedEntity',
        resolvedCategoryPath: 'Tech',
        knowledgePointKeys: ['kp:0'],
        outputMode: 'full_summary',
        discoveredAliases: ['alias-should-not-appear'],
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
        ],
      },
    ];

    const ctx = makeStoreCtx(sourceId, taskId, validEntities, points);
    ctx.verifierRejections = [{ pointKey: 'kp:0', reason: 'hallucination' }];

    await executeStoring(ctx, {
      db: t.db,
      categoryRepo,
      sourceRepo,
      knowledgeRepo,
      taskRepo,
      eventLogRepo,
    });

    const entity = knowledgeRepo.getEntityById(existingEntity.id)!;
    const aliases = JSON.parse(entity.aliases);
    expect(aliases).not.toContain('alias-should-not-appear');
  });

  it('builds ProcessingResult with correct stats invariant', async () => {
    const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');
    const { sourceId, taskId } = setupSourceAndTask();

    const points: IndexedPoint[] = [
      { pointKey: 'kp:0', content: 'New fact', type: 'fact' },
      { pointKey: 'kp:1', content: 'Skipped fact', type: 'fact' },
      { pointKey: 'kp:2', content: 'Opinion', type: 'opinion' },
    ];

    const existingEntity = knowledgeRepo.createEntity({ name: 'E' });
    const existingPoint = knowledgeRepo.createPoint('Existing content', 'fact');
    const prevSource = sourceRepo.create({ kind: 'user', rawContent: 'prev' });
    knowledgeRepo.createSourceEntityPoint(
      prevSource.id,
      existingEntity.id,
      existingPoint.id,
      'new',
    );
    sourceRepo.updateStatus(prevSource.id, 'confirmed');

    const validEntities: EntityJudgment[] = [
      {
        entityKey: `entity:${existingEntity.id}`,
        entityName: 'E',
        resolvedCategoryPath: 'Tech',
        knowledgePointKeys: ['kp:0', 'kp:1', 'kp:2'],
        outputMode: 'full_summary',
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          {
            pointKey: 'kp:1',
            judgment: 'skipped',
            matchedPointId: existingPoint.id,
            matchedContent: 'Existing content',
          },
          { pointKey: 'kp:2', judgment: 'new', matchedPointId: null, matchedContent: null },
        ],
      },
    ];

    const ctx = makeStoreCtx(sourceId, taskId, validEntities, points);
    await executeStoring(ctx, {
      db: t.db,
      categoryRepo,
      sourceRepo,
      knowledgeRepo,
      taskRepo,
      eventLogRepo,
    });

    const task = taskRepo.getById(taskId)!;
    const result = JSON.parse(task.result!);

    expect(result.stats.extracted).toBe(3);
    expect(result.stats.accepted).toBe(2);
    expect(result.stats.skipped).toBe(1);
    expect(result.stats.extracted).toBe(
      result.stats.accepted +
        result.stats.droppedUnassigned +
        result.stats.quarantined +
        result.stats.skipped +
        result.stats.verifierRejected,
    );
  });

  it('cross-entity: pointKey new in A + isolated in B → accepted', async () => {
    const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');
    const { sourceId, taskId } = setupSourceAndTask();

    const points: IndexedPoint[] = [{ pointKey: 'kp:0', content: 'Cross fact', type: 'fact' }];

    const entityA = knowledgeRepo.createEntity({ name: 'EntityA' });

    const validEntities: EntityJudgment[] = [
      {
        entityKey: `entity:${entityA.id}`,
        entityName: 'EntityA',
        resolvedCategoryPath: 'Tech',
        knowledgePointKeys: ['kp:0'],
        outputMode: 'full_summary',
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
        ],
      },
    ];

    const ctx = makeStoreCtx(sourceId, taskId, validEntities, points);
    ctx.validationResult!.droppedPoints = [
      {
        pointKey: 'kp:0',
        entityKey: 'entity:draft:BadEntity',
        content: 'Cross fact',
        type: 'fact',
        reason: 'invalid_entity_ref',
      },
    ];
    await executeStoring(ctx, {
      db: t.db,
      categoryRepo,
      sourceRepo,
      knowledgeRepo,
      taskRepo,
      eventLogRepo,
    });

    const task = taskRepo.getById(taskId)!;
    const result = JSON.parse(task.result!);
    expect(result.stats.accepted).toBe(1);
    expect(result.stats.quarantined).toBe(0);
  });

  it('cross-entity: skipped in A + verifier rejected → skipped (stored point takes precedence)', async () => {
    const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');
    const { sourceId, taskId } = setupSourceAndTask();

    const entityA = knowledgeRepo.createEntity({ name: 'EntityA' });
    const existingPoint = knowledgeRepo.createPoint('Old content', 'fact');
    const prevSource = sourceRepo.create({ kind: 'user', rawContent: 'prev' });
    knowledgeRepo.createSourceEntityPoint(prevSource.id, entityA.id, existingPoint.id, 'new');
    sourceRepo.updateStatus(prevSource.id, 'confirmed');

    const points: IndexedPoint[] = [{ pointKey: 'kp:0', content: 'Rejected fact', type: 'fact' }];

    const validEntities: EntityJudgment[] = [
      {
        entityKey: `entity:${entityA.id}`,
        entityName: 'EntityA',
        resolvedCategoryPath: 'Tech',
        knowledgePointKeys: ['kp:0'],
        outputMode: 'full_summary',
        pointJudgments: [
          {
            pointKey: 'kp:0',
            judgment: 'skipped',
            matchedPointId: existingPoint.id,
            matchedContent: 'Old content',
          },
        ],
      },
    ];

    const ctx = makeStoreCtx(sourceId, taskId, validEntities, points);
    ctx.verifierRejections = [{ pointKey: 'kp:0', reason: 'Factual error' }];
    await executeStoring(ctx, {
      db: t.db,
      categoryRepo,
      sourceRepo,
      knowledgeRepo,
      taskRepo,
      eventLogRepo,
    });

    const task = taskRepo.getById(taskId)!;
    const result = JSON.parse(task.result!);
    expect(result.stats.skipped).toBe(1);
    expect(result.stats.verifierRejected).toBe(0);
  });

  it('droppedPoints deduped by pointKey in ProcessingResult', async () => {
    const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');
    const { sourceId, taskId } = setupSourceAndTask();

    const points: IndexedPoint[] = [{ pointKey: 'kp:0', content: 'Orphan', type: 'fact' }];

    const validEntities: EntityJudgment[] = [];
    const ctx = makeStoreCtx(sourceId, taskId, validEntities, points);
    ctx.validationResult!.droppedPoints = [
      {
        pointKey: 'kp:0',
        entityKey: 'entity:draft:Bad1',
        content: 'Orphan',
        type: 'fact',
        reason: 'invalid_entity_ref',
      },
      {
        pointKey: 'kp:0',
        entityKey: 'entity:draft:Bad2',
        content: 'Orphan',
        type: 'fact',
        reason: 'invalid_entity_ref',
      },
    ];
    await executeStoring(ctx, {
      db: t.db,
      categoryRepo,
      sourceRepo,
      knowledgeRepo,
      taskRepo,
      eventLogRepo,
    });

    const task = taskRepo.getById(taskId)!;
    const result = JSON.parse(task.result!);
    expect(result.droppedPoints).toHaveLength(1);
    expect(result.stats.quarantined).toBe(1);
  });

  it('excludes accepted points from droppedPoints in result', async () => {
    const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');
    const { sourceId, taskId } = setupSourceAndTask();

    const existingEntity = knowledgeRepo.createEntity({ name: 'ValidEntity' });
    const catId = categoryRepo.ensureCategoryPath('Tech');
    knowledgeRepo.linkEntityToCategory(existingEntity.id, catId);

    const points: IndexedPoint[] = [{ pointKey: 'kp:0', content: 'Shared fact', type: 'fact' }];

    // kp:0 is assigned to a valid entity AND appears in droppedPoints from an invalid entity
    const validEntities: EntityJudgment[] = [
      {
        entityKey: `entity:${existingEntity.id}`,
        entityName: 'ValidEntity',
        resolvedCategoryPath: 'Tech',
        knowledgePointKeys: ['kp:0'],
        outputMode: 'full_summary',
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
        ],
      },
    ];

    const ctx = makeStoreCtx(sourceId, taskId, validEntities, points);
    // Simulate validation having dropped the same point from an invalid entity
    ctx.validationResult!.droppedPoints = [
      {
        pointKey: 'kp:0',
        entityKey: 'entity:999',
        content: 'Shared fact',
        type: 'fact',
        reason: 'invalid_entity_ref',
      },
    ];
    await executeStoring(ctx, {
      db: t.db,
      categoryRepo,
      sourceRepo,
      knowledgeRepo,
      taskRepo,
      eventLogRepo,
    });

    const task = taskRepo.getById(taskId)!;
    const result = JSON.parse(task.result!);

    // kp:0 was accepted via ValidEntity, so it should NOT appear in droppedPoints
    expect(result.droppedPoints).toBeUndefined();
    expect(result.stats.accepted).toBe(1);
  });

  it('should backfill matchedContent from DB instead of LLM paraphrase', async () => {
    const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');
    const { sourceId, taskId } = setupSourceAndTask();

    const existingEntity = knowledgeRepo.createEntity({ name: 'E' });
    const existingPoint = knowledgeRepo.createPoint('Accurate DB content', 'fact');
    const prevSource = sourceRepo.create({ kind: 'user', rawContent: 'prev' });
    knowledgeRepo.createSourceEntityPoint(
      prevSource.id,
      existingEntity.id,
      existingPoint.id,
      'new',
    );
    sourceRepo.updateStatus(prevSource.id, 'confirmed');

    const points: IndexedPoint[] = [{ pointKey: 'kp:0', content: 'Duplicate fact', type: 'fact' }];
    const validEntities: EntityJudgment[] = [
      {
        entityKey: `entity:${existingEntity.id}`,
        entityName: 'E',
        resolvedCategoryPath: 'Tech',
        knowledgePointKeys: ['kp:0'],
        outputMode: 'full_summary',
        pointJudgments: [
          {
            pointKey: 'kp:0',
            judgment: 'skipped',
            matchedPointId: existingPoint.id,
            matchedContent: 'LLM paraphrased version',
          },
        ],
      },
    ];

    const ctx = makeStoreCtx(sourceId, taskId, validEntities, points);
    await executeStoring(ctx, {
      db: t.db,
      categoryRepo,
      sourceRepo,
      knowledgeRepo,
      taskRepo,
      eventLogRepo,
    });

    const task = taskRepo.getById(taskId)!;
    const result = JSON.parse(task.result!);
    const skippedPoints = result.entities[0].skippedFactPoints;
    expect(skippedPoints[0].matchedContent).toBe('Accurate DB content');
  });

  it('uses pointEmbeddingsCache when available instead of calling embedMany for points', async () => {
    const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');
    const { sourceId, taskId } = setupSourceAndTask();

    const points: IndexedPoint[] = [
      { pointKey: 'kp:0', content: 'Fact about AI', type: 'fact' },
      { pointKey: 'kp:1', content: 'Another fact', type: 'fact' },
    ];

    const validEntities: EntityJudgment[] = [
      {
        entityKey: 'draft:ai-company',
        entityName: 'AI Company',
        resolvedCategoryPath: 'Tech/AI',
        knowledgePointKeys: ['kp:0', 'kp:1'],
        outputMode: 'full_summary',
        pointJudgments: [
          {
            pointKey: 'kp:0',
            judgment: 'new' as const,
            matchedPointId: null,
            matchedContent: null,
          },
          {
            pointKey: 'kp:1',
            judgment: 'new' as const,
            matchedPointId: null,
            matchedContent: null,
          },
        ],
      },
    ];

    const cache = new Map<string, number[]>();
    cache.set('kp:0', [0.1, 0.2, 0.3]);
    cache.set('kp:1', [0.4, 0.5, 0.6]);

    const ctx = {
      ...makeStoreCtx(sourceId, taskId, validEntities, points),
      pointEmbeddingsCache: cache,
    };

    const mockEmbeddingProvider = {
      embedMany: vi.fn().mockResolvedValue([[0.7, 0.8, 0.9]]),
      embed: vi.fn(),
      dimensions: 3,
      modelId: 'test',
    };

    await executeStoring(ctx, {
      db: t.db,
      categoryRepo,
      sourceRepo,
      knowledgeRepo,
      taskRepo,
      eventLogRepo,
      embeddingProvider: mockEmbeddingProvider,
    });

    // embedMany should be called once for entities, but NOT for points (all cached)
    // The vec table write will fail silently (no sqlite-vec), which is expected
    const calls = mockEmbeddingProvider.embedMany.mock.calls;

    // Filter calls: entity embedding calls contain entity text (from composeEntityText),
    // point embedding calls would contain point content text
    const pointContentTexts = points.map((p) => p.content);
    const pointEmbedCalls = calls.filter((call: any[]) => {
      const texts: string[] = call[0];
      return texts.some((text: string) => pointContentTexts.includes(text));
    });

    expect(pointEmbedCalls).toHaveLength(0);
  });

  describe('relation storing', () => {
    it('writes relations to entity_relations table', async () => {
      const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');
      const { sourceId, taskId } = setupSourceAndTask();

      const points: IndexedPoint[] = [
        { pointKey: 'kp:0', content: 'Fact about A', type: 'fact' },
        { pointKey: 'kp:1', content: 'Fact about B', type: 'fact' },
      ];
      const validEntities: EntityJudgment[] = [
        {
          entityKey: 'draft:entity-a',
          entityName: 'Entity A',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          keywords: ['a'],
          description: 'Entity A desc',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
        {
          entityKey: 'draft:entity-b',
          entityName: 'Entity B',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:1'],
          outputMode: 'full_summary',
          keywords: ['b'],
          description: 'Entity B desc',
          pointJudgments: [
            { pointKey: 'kp:1', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ];

      const validRelations: RelationOutput[] = [
        {
          sourceEntityKey: 'draft:entity-a',
          targetEntityKey: 'draft:entity-b',
          relationType: 'collaborative',
          description: 'A collaborates with B',
        },
      ];

      const ctx = makeStoreCtx(sourceId, taskId, validEntities, points);
      ctx.relations = validRelations;
      ctx.validationResult!.validRelations = validRelations;

      await executeStoring(ctx, {
        db: t.db,
        categoryRepo,
        sourceRepo,
        knowledgeRepo,
        taskRepo,
        eventLogRepo,
      });

      const rows = t.db.select().from(schema.entityRelations).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].relationType).toBe('collaborative');
      expect(rows[0].description).toBe('A collaborates with B');
      expect(rows[0].sourceId).toBe(sourceId);

      // Verify the entity IDs are correct real IDs (not draft keys)
      const entities = t.db.select().from(schema.entities).all();
      const entityA = entities.find((e) => e.name === 'Entity A')!;
      const entityB = entities.find((e) => e.name === 'Entity B')!;
      expect(rows[0].sourceEntityId).toBe(entityA.id);
      expect(rows[0].targetEntityId).toBe(entityB.id);
    });

    it('skips duplicate relations with ON CONFLICT DO NOTHING', async () => {
      const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');

      // --- First pipeline run ---
      const { sourceId: sourceId1, taskId: taskId1 } = setupSourceAndTask();
      const points1: IndexedPoint[] = [
        { pointKey: 'kp:0', content: 'Fact about X', type: 'fact' },
        { pointKey: 'kp:1', content: 'Fact about Y', type: 'fact' },
      ];
      const validEntities1: EntityJudgment[] = [
        {
          entityKey: 'draft:entity-x',
          entityName: 'Entity X',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          keywords: ['x'],
          description: 'Entity X desc',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
        {
          entityKey: 'draft:entity-y',
          entityName: 'Entity Y',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:1'],
          outputMode: 'full_summary',
          keywords: ['y'],
          description: 'Entity Y desc',
          pointJudgments: [
            { pointKey: 'kp:1', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ];
      const relation: RelationOutput = {
        sourceEntityKey: 'draft:entity-x',
        targetEntityKey: 'draft:entity-y',
        relationType: 'competitive',
        description: 'X competes with Y',
      };

      const ctx1 = makeStoreCtx(sourceId1, taskId1, validEntities1, points1);
      ctx1.relations = [relation];
      ctx1.validationResult!.validRelations = [relation];

      await executeStoring(ctx1, {
        db: t.db,
        categoryRepo,
        sourceRepo,
        knowledgeRepo,
        taskRepo,
        eventLogRepo,
      });

      const afterFirst = t.db.select().from(schema.entityRelations).all();
      expect(afterFirst).toHaveLength(1);

      // --- Second pipeline run with same relation (now referencing existing entities) ---
      const entities = t.db.select().from(schema.entities).all();
      const entityX = entities.find((e) => e.name === 'Entity X')!;
      const entityY = entities.find((e) => e.name === 'Entity Y')!;

      const { sourceId: sourceId2, taskId: taskId2 } = setupSourceAndTask();
      const points2: IndexedPoint[] = [
        { pointKey: 'kp:0', content: 'Another fact about X', type: 'fact' },
      ];
      const validEntities2: EntityJudgment[] = [
        {
          entityKey: `entity:${entityX.id}`,
          entityName: 'Entity X',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ];
      const relation2: RelationOutput = {
        sourceEntityKey: `entity:${entityX.id}`,
        targetEntityKey: `entity:${entityY.id}`,
        relationType: 'competitive',
        description: 'X competes with Y (again)',
      };

      const ctx2 = makeStoreCtx(sourceId2, taskId2, validEntities2, points2);
      ctx2.relations = [relation2];
      ctx2.validationResult!.validRelations = [relation2];

      await executeStoring(ctx2, {
        db: t.db,
        categoryRepo,
        sourceRepo,
        knowledgeRepo,
        taskRepo,
        eventLogRepo,
      });

      // Still only 1 row due to ON CONFLICT DO NOTHING
      const afterSecond = t.db.select().from(schema.entityRelations).all();
      expect(afterSecond).toHaveLength(1);
    });

    it('includes relationStats in ProcessingResult', async () => {
      const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');
      const { sourceId, taskId } = setupSourceAndTask();

      const points: IndexedPoint[] = [
        { pointKey: 'kp:0', content: 'Fact 1', type: 'fact' },
        { pointKey: 'kp:1', content: 'Fact 2', type: 'fact' },
      ];
      const validEntities: EntityJudgment[] = [
        {
          entityKey: 'draft:alpha',
          entityName: 'Alpha',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          keywords: ['alpha'],
          description: 'Alpha desc',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
        {
          entityKey: 'draft:beta',
          entityName: 'Beta',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:1'],
          outputMode: 'full_summary',
          keywords: ['beta'],
          description: 'Beta desc',
          pointJudgments: [
            { pointKey: 'kp:1', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ];

      const relations: RelationOutput[] = [
        {
          sourceEntityKey: 'draft:alpha',
          targetEntityKey: 'draft:beta',
          relationType: 'technical',
          description: 'Alpha depends on Beta',
        },
      ];

      const ctx = makeStoreCtx(sourceId, taskId, validEntities, points);
      // Set extracted relations on ctx (from relating step)
      ctx.relations = [
        ...relations,
        // Add an extra relation that would have been dropped during validation
        {
          sourceEntityKey: 'draft:alpha',
          targetEntityKey: 'draft:alpha',
          relationType: 'general',
          description: 'Self ref (would be dropped)',
        },
      ];
      ctx.validationResult!.validRelations = relations;

      const result = await executeStoring(ctx, {
        db: t.db,
        categoryRepo,
        sourceRepo,
        knowledgeRepo,
        taskRepo,
        eventLogRepo,
      });

      const task = taskRepo.getById(taskId)!;
      const parsed = JSON.parse(task.result!);
      expect(parsed.relationStats).toEqual({
        extracted: 2,
        validated: 1,
        stored: 1,
        deduplicated: 0,
      });

      // Also verify on returned context
      expect(result.processingResult!.relationStats).toEqual({
        extracted: 2,
        validated: 1,
        stored: 1,
        deduplicated: 0,
      });
    });

    it('skips relations referencing uncreated draft entities', async () => {
      const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');
      const { sourceId, taskId } = setupSourceAndTask();

      // draft:ghost has no points that survive → never created
      const points: IndexedPoint[] = [
        { pointKey: 'kp:0', content: 'Good fact', type: 'fact' },
        { pointKey: 'kp:1', content: 'Ghost fact', type: 'fact' },
      ];
      const validEntities: EntityJudgment[] = [
        {
          entityKey: 'draft:real',
          entityName: 'Real Entity',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          keywords: ['real'],
          description: 'Real desc',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
        {
          entityKey: 'draft:ghost',
          entityName: 'Ghost Entity',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:1'],
          outputMode: 'full_summary',
          keywords: ['ghost'],
          description: 'Ghost desc',
          // All points rejected by verifier → draft not created
          pointJudgments: [
            { pointKey: 'kp:1', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ];

      const relation: RelationOutput = {
        sourceEntityKey: 'draft:real',
        targetEntityKey: 'draft:ghost',
        relationType: 'organizational',
        description: 'Real relates to Ghost',
      };

      const ctx = makeStoreCtx(sourceId, taskId, validEntities, points);
      ctx.relations = [relation];
      ctx.validationResult!.validRelations = [relation];
      // Reject ghost's only point so the draft entity is never created
      ctx.verifierRejections = [{ pointKey: 'kp:1', reason: 'hallucination' }];

      await executeStoring(ctx, {
        db: t.db,
        categoryRepo,
        sourceRepo,
        knowledgeRepo,
        taskRepo,
        eventLogRepo,
      });

      // Relation should not be written since draft:ghost was never created
      const rows = t.db.select().from(schema.entityRelations).all();
      expect(rows).toHaveLength(0);

      // Only Real Entity was created
      const entities = t.db.select().from(schema.entities).all();
      expect(entities).toHaveLength(1);
      expect(entities[0].name).toBe('Real Entity');
    });

    it('does not include relationStats when ctx.relations is absent', async () => {
      const { executeStoring } = await import('../../../src/pipeline/steps/storing.js');
      const { sourceId, taskId } = setupSourceAndTask();

      const points: IndexedPoint[] = [{ pointKey: 'kp:0', content: 'Simple fact', type: 'fact' }];
      const validEntities: EntityJudgment[] = [
        {
          entityKey: 'draft:simple',
          entityName: 'Simple',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
          outputMode: 'full_summary',
          keywords: ['simple'],
          description: 'Simple desc',
          pointJudgments: [
            { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          ],
        },
      ];

      const ctx = makeStoreCtx(sourceId, taskId, validEntities, points);
      // No ctx.relations set (pipeline without relating step)

      await executeStoring(ctx, {
        db: t.db,
        categoryRepo,
        sourceRepo,
        knowledgeRepo,
        taskRepo,
        eventLogRepo,
      });

      const task = taskRepo.getById(taskId)!;
      const parsed = JSON.parse(task.result!);
      expect(parsed.relationStats).toBeUndefined();
    });
  });
});
