import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineError } from '../../../src/pipeline/types.js';
import {
  createMockCallLlm,
  createMockLlmCallRepo,
  createTestConfig,
  createTestContext,
  createTestIndexedPoints,
  resetIdSequences,
} from '../fixtures/index.js';

vi.mock('../../../src/prompts/loader.js', () => ({
  loadPromptTemplate: vi.fn().mockReturnValue('mock relator template'),
  compilePrompt: vi
    .fn()
    .mockImplementation((_t: string, vars: any) => `compiled: ${JSON.stringify(vars)}`),
  computePromptHash: vi.fn().mockReturnValue('abc12345'),
}));

describe('relating step', () => {
  let mockLlm: ReturnType<typeof createMockCallLlm>;
  let llmCallRepo: ReturnType<typeof createMockLlmCallRepo>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetIdSequences();
    mockLlm = createMockCallLlm();
    llmCallRepo = createMockLlmCallRepo();
  });

  it('returns empty relations when relation.enabled is false', async () => {
    const { executeRelating } = await import('../../../src/pipeline/steps/relating.js');

    const ctx = createTestContext({
      config: createTestConfig({ relation: { enabled: false } }),
      points: createTestIndexedPoints(2),
      matchingOutput: {
        entities: [
          {
            entityKey: 'entity:1',
            entityName: 'Entity A',
            resolvedCategoryPath: 'Tech/AI',
            knowledgePointKeys: ['kp:0'],
          },
          {
            entityKey: 'entity:2',
            entityName: 'Entity B',
            resolvedCategoryPath: 'Tech/AI',
            knowledgePointKeys: ['kp:1'],
          },
        ],
      },
    });

    const result = await executeRelating(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
    });

    expect(result.relations).toEqual([]);
    expect(mockLlm.fn).not.toHaveBeenCalled();
  });

  it('returns empty relations when fewer than 2 entities', async () => {
    const { executeRelating } = await import('../../../src/pipeline/steps/relating.js');

    const ctx = createTestContext({
      config: createTestConfig({ relation: { enabled: true } }),
      points: createTestIndexedPoints(1),
      matchingOutput: {
        entities: [
          {
            entityKey: 'entity:1',
            entityName: 'Entity A',
            resolvedCategoryPath: 'Tech/AI',
            knowledgePointKeys: ['kp:0'],
          },
        ],
      },
    });

    const result = await executeRelating(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
    });

    expect(result.relations).toEqual([]);
    expect(mockLlm.fn).not.toHaveBeenCalled();
  });

  it('extracts relations from LLM output', async () => {
    const { executeRelating } = await import('../../../src/pipeline/steps/relating.js');

    mockLlm.mockResolvedOutput({
      relations: [
        {
          sourceEntityKey: 'entity:1',
          targetEntityKey: 'entity:2',
          relationType: 'competitive',
          description: 'Entity A competes with Entity B in the AI space',
        },
      ],
    });

    const ctx = createTestContext({
      config: createTestConfig({ relation: { enabled: true } }),
      points: createTestIndexedPoints(2),
      matchingOutput: {
        entities: [
          {
            entityKey: 'entity:1',
            entityName: 'Entity A',
            resolvedCategoryPath: 'Tech/AI',
            knowledgePointKeys: ['kp:0'],
          },
          {
            entityKey: 'entity:2',
            entityName: 'Entity B',
            resolvedCategoryPath: 'Tech/AI',
            knowledgePointKeys: ['kp:1'],
          },
        ],
      },
    });

    const result = await executeRelating(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
    });

    expect(result.relations).toHaveLength(1);
    expect(result.relations![0]).toEqual({
      sourceEntityKey: 'entity:1',
      targetEntityKey: 'entity:2',
      relationType: 'competitive',
      description: 'Entity A competes with Entity B in the AI space',
    });
    expect(mockLlm.fn).toHaveBeenCalledTimes(1);
    expect(mockLlm.fn).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'relator',
        sourceId: ctx.source.id,
      }),
    );
  });

  it('throws PipelineError on LLM failure', async () => {
    const { executeRelating } = await import('../../../src/pipeline/steps/relating.js');
    mockLlm.mockRejectedError(new Error('LLM error'));

    const ctx = createTestContext({
      config: createTestConfig({ relation: { enabled: true } }),
      points: createTestIndexedPoints(2),
      matchingOutput: {
        entities: [
          {
            entityKey: 'entity:1',
            entityName: 'Entity A',
            resolvedCategoryPath: 'Tech/AI',
            knowledgePointKeys: ['kp:0'],
          },
          {
            entityKey: 'entity:2',
            entityName: 'Entity B',
            resolvedCategoryPath: 'Tech/AI',
            knowledgePointKeys: ['kp:1'],
          },
        ],
      },
    });

    await expect(executeRelating(ctx, { callLlm: mockLlm.fn, llmCallRepo })).rejects.toThrow(
      PipelineError,
    );
  });
});
