import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineError } from '../../../src/pipeline/types.js';
import {
  createMockCallLlm,
  createMockKnowledgeRepo,
  createMockLlmCallRepo,
  createTestContext,
  createTestEntity,
  createTestIndexedPoints,
  resetIdSequences,
} from '../fixtures/index.js';

vi.mock('../../../src/db/connection.js', () => ({
  getRawDatabase: vi.fn(),
}));

vi.mock('../../../src/prompts/loader.js', () => ({
  loadPromptTemplate: vi.fn().mockReturnValue('mock matcher template'),
  compilePrompt: vi
    .fn()
    .mockImplementation((_t: string, vars: any) => `compiled: ${JSON.stringify(vars)}`),
  computePromptHash: vi.fn().mockReturnValue('abc12345'),
}));

describe('matching step', () => {
  let mockLlm: ReturnType<typeof createMockCallLlm>;
  let knowledgeRepo: ReturnType<typeof createMockKnowledgeRepo>;
  let llmCallRepo: ReturnType<typeof createMockLlmCallRepo>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetIdSequences();
    mockLlm = createMockCallLlm();
    knowledgeRepo = createMockKnowledgeRepo();
    llmCallRepo = createMockLlmCallRepo();
  });

  it('matches points to existing entity', async () => {
    const { executeMatching } = await import('../../../src/pipeline/steps/matching.js');
    knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([
      {
        ...createTestEntity({ id: 1, name: 'Claude Code', description: 'AI CLI tool' }),
        categoryPaths: ['/Tech/AI/Tools'],
      },
    ]);

    mockLlm.mockResolvedOutput({
      entities: [
        {
          entityKey: 'entity:1',
          entityName: 'Claude Code',
          resolvedCategoryPath: 'Tech/AI/Tools',
          knowledgePointKeys: ['kp:0', 'kp:1'],
          discoveredAliases: ['claude-code'],
        },
      ],
    });

    const points = createTestIndexedPoints(2);
    const ctx = createTestContext({
      points,
      classification: { categoryPath: 'Tech/AI', keywords: ['AI', 'CLI'] },
    });

    const result = await executeMatching(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      knowledgeRepo,
      db: {} as any,
    });
    expect(result.matchingOutput).toBeDefined();
    expect(result.matchingOutput?.entities).toHaveLength(1);
    expect(result.matchingOutput?.entities[0].entityKey).toBe('entity:1');
  });

  it('creates draft entity for new topic', async () => {
    const { executeMatching } = await import('../../../src/pipeline/steps/matching.js');
    knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([]);

    mockLlm.mockResolvedOutput({
      entities: [
        {
          entityKey: 'draft:new-tool',
          entityName: 'New Tool',
          resolvedCategoryPath: 'Tech/AI',
          knowledgePointKeys: ['kp:0'],
          keywords: ['tool', 'ai', 'automation'],
          description: 'A new AI tool',
        },
      ],
    });

    const points = createTestIndexedPoints(1);
    const ctx = createTestContext({
      points,
      classification: { categoryPath: 'Tech/AI', keywords: ['AI'] },
    });

    const result = await executeMatching(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      knowledgeRepo,
      db: {} as any,
    });
    expect(result.matchingOutput?.entities[0].entityKey).toBe('draft:new-tool');
    expect(result.matchingOutput?.entities[0].keywords).toEqual(['tool', 'ai', 'automation']);
  });

  it('supports cross-entity point sharing', async () => {
    const { executeMatching } = await import('../../../src/pipeline/steps/matching.js');
    knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([
      { ...createTestEntity({ id: 1, name: 'Claude Code' }), categoryPaths: ['/Tech/AI'] },
      { ...createTestEntity({ id: 2, name: 'Cursor' }), categoryPaths: ['/Tech/AI'] },
    ]);

    mockLlm.mockResolvedOutput({
      entities: [
        {
          entityKey: 'entity:1',
          entityName: 'Claude Code',
          resolvedCategoryPath: 'Tech/AI',
          knowledgePointKeys: ['kp:0'],
        },
        {
          entityKey: 'entity:2',
          entityName: 'Cursor',
          resolvedCategoryPath: 'Tech/AI',
          knowledgePointKeys: ['kp:0'],
        },
      ],
    });

    const points = createTestIndexedPoints(1);
    const ctx = createTestContext({
      points,
      classification: { categoryPath: 'Tech/AI', keywords: ['AI'] },
    });

    const result = await executeMatching(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      knowledgeRepo,
      db: {} as any,
    });
    expect(result.matchingOutput?.entities).toHaveLength(2);
    expect(result.matchingOutput?.entities[0].knowledgePointKeys).toContain('kp:0');
    expect(result.matchingOutput?.entities[1].knowledgePointKeys).toContain('kp:0');
  });

  it('injects entity registry into LLM prompt', async () => {
    const { executeMatching } = await import('../../../src/pipeline/steps/matching.js');
    const entity = createTestEntity({
      id: 5,
      name: 'Claude Code',
      description: 'AI CLI tool',
      aliases: JSON.stringify(['claude-code']),
      keywords: JSON.stringify(['CLI', 'AI']),
    });
    knowledgeRepo.getEntityRegistry = vi
      .fn()
      .mockReturnValue([{ ...entity, categoryPaths: ['/Tech/AI/Tools'] }]);

    mockLlm.mockResolvedOutput({
      entities: [
        {
          entityKey: 'entity:5',
          entityName: 'Claude Code',
          resolvedCategoryPath: 'Tech/AI/Tools',
          knowledgePointKeys: ['kp:0'],
        },
      ],
    });

    const ctx = createTestContext({
      points: createTestIndexedPoints(1),
      classification: { categoryPath: 'Tech', keywords: ['AI'] },
    });
    await executeMatching(ctx, { callLlm: mockLlm.fn, llmCallRepo, knowledgeRepo, db: {} as any });

    expect(knowledgeRepo.getEntityRegistry).toHaveBeenCalled();
    expect(mockLlm.fn).toHaveBeenCalledTimes(1);
  });

  it('throws PipelineError on LLM failure', async () => {
    const { executeMatching } = await import('../../../src/pipeline/steps/matching.js');
    knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([]);
    mockLlm.mockRejectedError(new Error('LLM error'));

    const ctx = createTestContext({
      points: createTestIndexedPoints(1),
      classification: { categoryPath: 'Tech', keywords: ['AI'] },
    });

    await expect(
      executeMatching(ctx, { callLlm: mockLlm.fn, llmCallRepo, knowledgeRepo, db: {} as any }),
    ).rejects.toThrow(PipelineError);
  });

  it('does not prefilter when embeddingProvider is null', async () => {
    const { executeMatching } = await import('../../../src/pipeline/steps/matching.js');
    const entity1 = createTestEntity({ id: 1, name: 'Entity One' });
    const entity2 = createTestEntity({ id: 2, name: 'Entity Two' });
    knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue([
      { ...entity1, categoryPaths: ['/Tech'], activePointCount: 1 },
      { ...entity2, categoryPaths: ['/Tech'], activePointCount: 1 },
    ]);

    mockLlm.mockResolvedOutput({
      entities: [
        {
          entityKey: 'entity:1',
          entityName: 'Entity One',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
        },
      ],
    });

    const ctx = createTestContext({
      points: createTestIndexedPoints(1),
      classification: { categoryPath: 'Tech', keywords: ['test'] },
    });

    const result = await executeMatching(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      knowledgeRepo,
      embeddingProvider: null,
      db: {} as any,
    });

    expect(result.matchingOutput).toBeDefined();
    expect(result.pointEmbeddingsCache).toBeUndefined();
  });

  it('falls back to full registry when prefilter fails', async () => {
    const { executeMatching } = await import('../../../src/pipeline/steps/matching.js');

    const entities = Array.from({ length: 31 }, (_, i) => ({
      ...createTestEntity({ id: i + 1, name: `Entity ${i + 1}` }),
      categoryPaths: ['/Tech'],
      activePointCount: 1,
    }));
    knowledgeRepo.getEntityRegistry = vi.fn().mockReturnValue(entities);

    mockLlm.mockResolvedOutput({
      entities: [
        {
          entityKey: 'entity:1',
          entityName: 'Entity 1',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
        },
      ],
    });

    const ctx = createTestContext({
      points: createTestIndexedPoints(1),
      classification: { categoryPath: 'Tech', keywords: ['test'] },
    });

    const failingProvider = {
      embedMany: vi.fn().mockRejectedValue(new Error('API down')),
      embed: vi.fn(),
      dimensions: 3,
      modelId: 'test',
    };

    const mockRawDb = {};
    const { getRawDatabase } = await import('../../../src/db/connection.js');
    vi.mocked(getRawDatabase).mockReturnValue(mockRawDb as any);

    const result = await executeMatching(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      knowledgeRepo,
      db: {} as any,
      embeddingProvider: failingProvider,
    });

    expect(result.matchingOutput).toBeDefined();
    expect(result.matchingOutput?.entities[0].entityKey).toBe('entity:1');
    expect(failingProvider.embedMany).toHaveBeenCalledTimes(1);
  });
});
