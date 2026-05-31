import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineError } from '../../../src/errors.js';
import { executeComparing } from '../../../src/pipeline/steps/comparing.js';
import type { IndexedPoint, MatchingOutput } from '../../../src/pipeline/types.js';
import {
  createMockCallLlm,
  createMockKnowledgeRepo,
  createMockLlmCallRepo,
  createTestConfig,
  createTestContext,
  createTestPoint,
  resetIdSequences,
} from '../fixtures/index.js';

vi.mock('../../../src/prompts/loader.js', () => ({
  loadPromptTemplate: vi.fn().mockReturnValue('mock comparator template'),
  compilePrompt: vi
    .fn()
    .mockImplementation((_t: string, vars: any) => `compiled: ${JSON.stringify(vars)}`),
  computePromptHash: vi.fn().mockReturnValue('abc12345'),
}));

describe('comparing step', () => {
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

  it('skips LLM call for draft entity (all points marked new)', async () => {
    const { executeComparing } = await import('../../../src/pipeline/steps/comparing.js');

    const points: IndexedPoint[] = [
      { pointKey: 'kp:0', content: 'New fact', type: 'fact' },
      { pointKey: 'kp:1', content: 'New opinion', type: 'opinion' },
    ];
    const matchingOutput: MatchingOutput = {
      entities: [
        {
          entityKey: 'draft:new-tool',
          entityName: 'New Tool',
          resolvedCategoryPath: 'Tech/AI',
          knowledgePointKeys: ['kp:0', 'kp:1'],
          keywords: ['tool', 'ai', 'new'],
          description: 'A new tool',
        },
      ],
    };

    const ctx = createTestContext({ points, matchingOutput });
    const result = await executeComparing(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      knowledgeRepo,
    });

    expect(mockLlm.fn).not.toHaveBeenCalled();
    expect(result.entityJudgments).toHaveLength(1);
    const ej = result.entityJudgments[0];
    expect(ej.pointJudgments).toHaveLength(2);
    expect(ej.pointJudgments.every((j) => j.judgment === 'new')).toBe(true);
  });

  it('skips LLM call when existing entity has no active fact points', async () => {
    const { executeComparing } = await import('../../../src/pipeline/steps/comparing.js');
    knowledgeRepo.getActiveFactPointsForEntity = vi.fn().mockReturnValue([]);

    const points: IndexedPoint[] = [{ pointKey: 'kp:0', content: 'Some fact', type: 'fact' }];
    const matchingOutput: MatchingOutput = {
      entities: [
        {
          entityKey: 'entity:1',
          entityName: 'Entity 1',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
        },
      ],
    };

    const ctx = createTestContext({ points, matchingOutput });
    const result = await executeComparing(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      knowledgeRepo,
    });

    expect(mockLlm.fn).not.toHaveBeenCalled();
    expect(result.entityJudgments[0].pointJudgments[0].judgment).toBe('new');
  });

  it('calls LLM for existing entity with active fact points', async () => {
    const { executeComparing } = await import('../../../src/pipeline/steps/comparing.js');
    const existingPoint = createTestPoint({ id: 10, content: 'Existing fact', type: 'fact' });
    knowledgeRepo.getActiveFactPointsForEntity = vi.fn().mockReturnValue([existingPoint]);

    mockLlm.mockResolvedOutput({
      summary: 'Comparison summary',
      pointJudgments: [
        {
          pointKey: 'kp:0',
          judgment: 'skipped',
          matchedPointId: 10,
          matchedContent: 'Existing fact',
        },
      ],
    });

    const points: IndexedPoint[] = [
      { pointKey: 'kp:0', content: 'Same as existing fact', type: 'fact' },
    ];
    const matchingOutput: MatchingOutput = {
      entities: [
        {
          entityKey: 'entity:1',
          entityName: 'Entity 1',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
        },
      ],
    };

    const ctx = createTestContext({ points, matchingOutput });
    const result = await executeComparing(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      knowledgeRepo,
    });

    expect(mockLlm.fn).toHaveBeenCalledTimes(1);
    expect(result.entityJudgments[0].pointJudgments[0].judgment).toBe('skipped');
    expect(result.entityJudgments[0].pointJudgments[0].matchedPointId).toBe(10);
    expect(result.entityJudgments[0].summary).toBe('Comparison summary');
  });

  it('opinion points bypass LLM comparison (always marked new)', async () => {
    const { executeComparing } = await import('../../../src/pipeline/steps/comparing.js');
    const existingPoint = createTestPoint({ id: 10, content: 'Existing fact', type: 'fact' });
    knowledgeRepo.getActiveFactPointsForEntity = vi.fn().mockReturnValue([existingPoint]);

    mockLlm.mockResolvedOutput({
      summary: 'Summary',
      pointJudgments: [
        { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
      ],
    });

    const points: IndexedPoint[] = [
      { pointKey: 'kp:0', content: 'New fact', type: 'fact' },
      { pointKey: 'kp:1', content: 'My opinion', type: 'opinion' },
    ];
    const matchingOutput: MatchingOutput = {
      entities: [
        {
          entityKey: 'entity:1',
          entityName: 'Entity 1',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0', 'kp:1'],
        },
      ],
    };

    const ctx = createTestContext({ points, matchingOutput });
    const result = await executeComparing(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      knowledgeRepo,
    });

    const ej = result.entityJudgments[0];
    expect(ej.pointJudgments).toHaveLength(2);
    const opinionJudgment = ej.pointJudgments.find((j) => j.pointKey === 'kp:1');
    expect(opinionJudgment?.judgment).toBe('new');
  });

  it('skips LLM call if entity only has opinion points', async () => {
    const { executeComparing } = await import('../../../src/pipeline/steps/comparing.js');
    knowledgeRepo.getActiveFactPointsForEntity = vi.fn().mockReturnValue([]);

    const points: IndexedPoint[] = [
      { pointKey: 'kp:0', content: 'Just an opinion', type: 'opinion' },
    ];
    const matchingOutput: MatchingOutput = {
      entities: [
        {
          entityKey: 'entity:1',
          entityName: 'Entity 1',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
        },
      ],
    };

    const ctx = createTestContext({ points, matchingOutput });
    const result = await executeComparing(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      knowledgeRepo,
    });

    expect(mockLlm.fn).not.toHaveBeenCalled();
    expect(result.entityJudgments[0].pointJudgments[0].judgment).toBe('new');
  });

  it('determines outputMode based on existing fact point count (full_summary)', async () => {
    const { executeComparing } = await import('../../../src/pipeline/steps/comparing.js');
    knowledgeRepo.getActiveFactPointsForEntity = vi
      .fn()
      .mockReturnValue([createTestPoint({ id: 1 }), createTestPoint({ id: 2 })]);
    mockLlm.mockResolvedOutput({
      pointJudgments: [
        { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
      ],
    });

    const points: IndexedPoint[] = [{ pointKey: 'kp:0', content: 'Fact', type: 'fact' }];
    const matchingOutput: MatchingOutput = {
      entities: [
        {
          entityKey: 'entity:1',
          entityName: 'E',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
        },
      ],
    };
    const config = createTestConfig({ outputFullThreshold: 2, outputIncrementThreshold: 10 });
    const ctx = createTestContext({ points, matchingOutput, config });

    const result = await executeComparing(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      knowledgeRepo,
    });
    expect(result.entityJudgments[0].outputMode).toBe('full_summary');
  });

  it('determines outputMode (summary_plus_increment for 3-10 existing)', async () => {
    const { executeComparing } = await import('../../../src/pipeline/steps/comparing.js');
    const existingPoints = Array.from({ length: 5 }, (_, i) => createTestPoint({ id: i + 1 }));
    knowledgeRepo.getActiveFactPointsForEntity = vi.fn().mockReturnValue(existingPoints);
    mockLlm.mockResolvedOutput({
      pointJudgments: [
        { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
      ],
    });

    const points: IndexedPoint[] = [{ pointKey: 'kp:0', content: 'Fact', type: 'fact' }];
    const matchingOutput: MatchingOutput = {
      entities: [
        {
          entityKey: 'entity:1',
          entityName: 'E',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
        },
      ],
    };
    const config = createTestConfig({ outputFullThreshold: 2, outputIncrementThreshold: 10 });
    const ctx = createTestContext({ points, matchingOutput, config });

    const result = await executeComparing(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      knowledgeRepo,
    });
    expect(result.entityJudgments[0].outputMode).toBe('summary_plus_increment');
  });

  it('determines outputMode (increment_only for >10 existing)', async () => {
    const { executeComparing } = await import('../../../src/pipeline/steps/comparing.js');
    const existingPoints = Array.from({ length: 11 }, (_, i) => createTestPoint({ id: i + 1 }));
    knowledgeRepo.getActiveFactPointsForEntity = vi.fn().mockReturnValue(existingPoints);
    mockLlm.mockResolvedOutput({
      pointJudgments: [
        { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
      ],
    });

    const points: IndexedPoint[] = [{ pointKey: 'kp:0', content: 'Fact', type: 'fact' }];
    const matchingOutput: MatchingOutput = {
      entities: [
        {
          entityKey: 'entity:1',
          entityName: 'E',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
        },
      ],
    };
    const config = createTestConfig({ outputFullThreshold: 2, outputIncrementThreshold: 10 });
    const ctx = createTestContext({ points, matchingOutput, config });

    const result = await executeComparing(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      knowledgeRepo,
    });
    expect(result.entityJudgments[0].outputMode).toBe('increment_only');
  });

  it('handles multiple entities with separate LLM calls', async () => {
    const { executeComparing } = await import('../../../src/pipeline/steps/comparing.js');
    knowledgeRepo.getActiveFactPointsForEntity = vi
      .fn()
      .mockReturnValueOnce([createTestPoint({ id: 10 })])
      .mockReturnValueOnce([]);

    mockLlm.fn.mockResolvedValueOnce({
      summary: 'Summary for entity 1',
      pointJudgments: [
        { pointKey: 'kp:0', judgment: 'skipped', matchedPointId: 10, matchedContent: 'Existing' },
      ],
    });

    const points: IndexedPoint[] = [
      { pointKey: 'kp:0', content: 'Shared fact', type: 'fact' },
      { pointKey: 'kp:1', content: 'Only entity 2 fact', type: 'fact' },
    ];
    const matchingOutput: MatchingOutput = {
      entities: [
        {
          entityKey: 'entity:1',
          entityName: 'E1',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
        },
        {
          entityKey: 'entity:2',
          entityName: 'E2',
          resolvedCategoryPath: 'Finance',
          knowledgePointKeys: ['kp:1'],
        },
      ],
    };

    const ctx = createTestContext({ points, matchingOutput });
    const result = await executeComparing(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      knowledgeRepo,
    });

    expect(result.entityJudgments).toHaveLength(2);
    expect(mockLlm.fn).toHaveBeenCalledTimes(1);
    expect(result.entityJudgments[1].pointJudgments[0].judgment).toBe('new');
  });

  it('degrades gracefully on LLM failure — treats points as new', async () => {
    const { executeComparing } = await import('../../../src/pipeline/steps/comparing.js');
    knowledgeRepo.getActiveFactPointsForEntity = vi.fn().mockReturnValue([createTestPoint()]);
    mockLlm.mockRejectedError(new Error('LLM error'));

    const points: IndexedPoint[] = [{ pointKey: 'kp:0', content: 'Fact', type: 'fact' }];
    const matchingOutput: MatchingOutput = {
      entities: [
        {
          entityKey: 'entity:1',
          entityName: 'E',
          resolvedCategoryPath: 'Tech',
          knowledgePointKeys: ['kp:0'],
        },
      ],
    };

    const ctx = createTestContext({ points, matchingOutput });
    const result = await executeComparing(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      knowledgeRepo,
    });
    expect(result.entityJudgments).toHaveLength(1);
    expect(result.entityJudgments[0].pointJudgments[0].judgment).toBe('new');
  });

  it('re-throws content_policy PipelineError instead of degrading', async () => {
    const { fn: mockCallLlm, mockRejectedError } = createMockCallLlm();
    const contentPolicyError = new PipelineError(
      'Content policy violation',
      'comparator',
      'content_policy',
    );
    mockRejectedError(contentPolicyError);

    const ctx = createTestContext({
      matchingOutput: {
        entities: [
          {
            entityKey: 'entity:1',
            entityName: 'Test Entity',
            knowledgePointKeys: ['kp:0'],
            resolvedCategoryPath: 'test',
            discoveredAliases: [],
            keywords: [],
            description: null,
          },
        ],
      },
      points: [{ pointKey: 'kp:0', content: 'test fact', type: 'fact' }],
    });

    const existingFactPoints = [
      { id: 1, content: 'existing fact', type: 'fact', status: 'active' },
    ];
    const mockKnowledgeRepo = {
      getActiveFactPointsForEntity: vi.fn().mockReturnValue(existingFactPoints),
      getActiveFactPointsForEntities: vi.fn().mockReturnValue(new Map([[1, existingFactPoints]])),
    };

    await expect(
      executeComparing(ctx, {
        callLlm: mockCallLlm as any,
        llmCallRepo: {} as any,
        knowledgeRepo: mockKnowledgeRepo as any,
      }),
    ).rejects.toThrow(contentPolicyError);
  });

  it('re-throws rate_limit PipelineError instead of degrading', async () => {
    const { fn: mockCallLlm, mockRejectedError } = createMockCallLlm();
    const rateLimitError = new PipelineError('Rate limit exceeded', 'comparator', 'rate_limit');
    mockRejectedError(rateLimitError);

    const ctx = createTestContext({
      matchingOutput: {
        entities: [
          {
            entityKey: 'entity:1',
            entityName: 'Test Entity',
            knowledgePointKeys: ['kp:0'],
            resolvedCategoryPath: 'test',
            discoveredAliases: [],
            keywords: [],
            description: null,
          },
        ],
      },
      points: [{ pointKey: 'kp:0', content: 'test fact', type: 'fact' }],
    });

    const existingFactPoints = [
      { id: 1, content: 'existing fact', type: 'fact', status: 'active' },
    ];
    const mockKnowledgeRepo = {
      getActiveFactPointsForEntity: vi.fn().mockReturnValue(existingFactPoints),
      getActiveFactPointsForEntities: vi.fn().mockReturnValue(new Map([[1, existingFactPoints]])),
    };

    await expect(
      executeComparing(ctx, {
        callLlm: mockCallLlm as any,
        llmCallRepo: {} as any,
        knowledgeRepo: mockKnowledgeRepo as any,
      }),
    ).rejects.toThrow(rateLimitError);
  });
});
