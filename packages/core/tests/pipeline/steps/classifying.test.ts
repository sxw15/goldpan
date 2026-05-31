// monorepo/packages/core/tests/pipeline/steps/classifying.test.ts
// NOTE: This file starts with schema validation tests only.
// Task 4 will add step execution tests below these.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  comparingLlmSchema,
  extractingSchema,
  matchingSchema,
  PipelineError,
  textClassificationSchema,
  urlClassificationSchema,
  verifierSchema,
} from '../../../src/pipeline/types.js';

describe('LLM Output Zod Schemas', () => {
  describe('urlClassificationSchema', () => {
    it('accepts valid URL classification', () => {
      const result = urlClassificationSchema.safeParse({
        categoryPath: 'Tech/AI/Tools',
        keywords: ['CLI', 'AI', 'coding'],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.categoryPath).toBe('Tech/AI/Tools');
        expect(result.data.keywords).toEqual(['CLI', 'AI', 'coding']);
      }
    });

    it('rejects missing categoryPath', () => {
      const result = urlClassificationSchema.safeParse({
        keywords: ['CLI'],
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty keywords array', () => {
      const result = urlClassificationSchema.safeParse({
        categoryPath: 'Tech',
        keywords: [],
      });
      expect(result.success).toBe(false);
    });

    it('rejects more than 5 keywords', () => {
      const result = urlClassificationSchema.safeParse({
        categoryPath: 'Tech',
        keywords: ['a', 'b', 'c', 'd', 'e', 'f'],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('textClassificationSchema', () => {
    it('accepts valid text classification with inputType', () => {
      const result = textClassificationSchema.safeParse({
        inputType: 'text',
        categoryPath: 'Finance/Investment',
        keywords: ['stocks', 'value investing'],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.inputType).toBe('text');
        expect(result.data.categoryPath).toBe('Finance/Investment');
        expect(result.data.keywords).toEqual(['stocks', 'value investing']);
      }
    });

    it('accepts opinion inputType', () => {
      const result = textClassificationSchema.safeParse({
        inputType: 'opinion',
        categoryPath: 'Tech',
        keywords: ['AI'],
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid inputType', () => {
      const result = textClassificationSchema.safeParse({
        inputType: 'url',
        categoryPath: 'Tech',
        keywords: ['AI'],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('extractingSchema', () => {
    it('accepts valid extraction output', () => {
      const result = extractingSchema.safeParse({
        points: [
          { content: 'Claude Code supports MCP', type: 'fact' },
          { content: 'I think AI is overhyped', type: 'opinion' },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.points).toHaveLength(2);
        // `tags` defaults to [] via zod when omitted — both fact and opinion
        // points carry the field even when extracting didn't surface any.
        expect(result.data.points[0]).toEqual({
          content: 'Claude Code supports MCP',
          type: 'fact',
          tags: [],
        });
        expect(result.data.points[1]).toEqual({
          content: 'I think AI is overhyped',
          type: 'opinion',
          tags: [],
        });
      }
    });

    it('parses tags on opinion points', () => {
      const result = extractingSchema.safeParse({
        points: [
          {
            content: 'I think Cursor moves faster than peers',
            type: 'opinion',
            tags: ['趋势判断', 'product-velocity'],
          },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.points[0].tags).toEqual(['趋势判断', 'product-velocity']);
      }
    });

    it('accepts empty points array (zero extraction)', () => {
      const result = extractingSchema.safeParse({ points: [] });
      expect(result.success).toBe(true);
    });

    it('rejects invalid point type', () => {
      const result = extractingSchema.safeParse({
        points: [{ content: 'test', type: 'unknown' }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('matchingSchema', () => {
    it('accepts existing entity reference', () => {
      const result = matchingSchema.safeParse({
        entities: [
          {
            entityKey: 'entity:42',
            entityName: 'Claude Code',
            resolvedCategoryPath: 'Tech/AI/Tools',
            knowledgePointKeys: ['kp:0', 'kp:1'],
            discoveredAliases: ['claude-code'],
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('accepts draft entity with required fields', () => {
      const result = matchingSchema.safeParse({
        entities: [
          {
            entityKey: 'draft:new-tool',
            entityName: 'New Tool',
            resolvedCategoryPath: 'Tech/AI',
            knowledgePointKeys: ['kp:0'],
            keywords: ['tool', 'ai', 'new'],
            description: 'a new AI tool',
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('accepts multiple entities (cross-entity point sharing)', () => {
      const result = matchingSchema.safeParse({
        entities: [
          {
            entityKey: 'entity:1',
            entityName: 'Claude Code',
            resolvedCategoryPath: 'Tech/AI/Tools',
            knowledgePointKeys: ['kp:0', 'kp:1'],
          },
          {
            entityKey: 'entity:2',
            entityName: 'Cursor',
            resolvedCategoryPath: 'Tech/AI/Tools',
            knowledgePointKeys: ['kp:0', 'kp:2'],
          },
        ],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('comparingLlmSchema', () => {
    it('accepts new judgment with null matchedPointId', () => {
      const result = comparingLlmSchema.safeParse({
        summary: 'New information about the tool',
        pointJudgments: [
          {
            pointKey: 'kp:0',
            judgment: 'new',
            matchedPointId: null,
            matchedContent: null,
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('accepts skipped judgment with matchedPointId', () => {
      const result = comparingLlmSchema.safeParse({
        pointJudgments: [
          {
            pointKey: 'kp:1',
            judgment: 'skipped',
            matchedPointId: 42,
            matchedContent: 'Existing fact content',
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('coerces string matchedPointId to number', () => {
      const result = comparingLlmSchema.safeParse({
        pointJudgments: [
          {
            pointKey: 'kp:1',
            judgment: 'skipped',
            matchedPointId: '42',
            matchedContent: 'Existing fact',
          },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pointJudgments[0].matchedPointId).toBe(42);
      }
    });

    it('preprocesses empty string matchedPointId to null', () => {
      const result = comparingLlmSchema.safeParse({
        pointJudgments: [
          {
            pointKey: 'kp:0',
            judgment: 'new',
            matchedPointId: '',
            matchedContent: null,
          },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pointJudgments[0].matchedPointId).toBeNull();
      }
    });

    it('accepts optional summary', () => {
      const result = comparingLlmSchema.safeParse({
        pointJudgments: [
          {
            pointKey: 'kp:0',
            judgment: 'new',
            matchedPointId: null,
            matchedContent: null,
          },
        ],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('verifierSchema', () => {
    it('accepts valid verifier output', () => {
      const result = verifierSchema.safeParse({
        verifiedPointKeys: ['kp:0', 'kp:2'],
        rejectedPointKeys: [
          { pointKey: 'kp:1', reason: 'Original content does not mention this fact' },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.verifiedPointKeys).toEqual(['kp:0', 'kp:2']);
        expect(result.data.rejectedPointKeys).toEqual([
          { pointKey: 'kp:1', reason: 'Original content does not mention this fact' },
        ]);
      }
    });

    it('accepts all verified', () => {
      const result = verifierSchema.safeParse({
        verifiedPointKeys: ['kp:0', 'kp:1'],
        rejectedPointKeys: [],
      });
      expect(result.success).toBe(true);
    });

    it('accepts all rejected', () => {
      const result = verifierSchema.safeParse({
        verifiedPointKeys: [],
        rejectedPointKeys: [{ pointKey: 'kp:0', reason: 'hallucination' }],
      });
      expect(result.success).toBe(true);
    });
  });
});

// ─── Step Execution Tests (Task 4) ──────────────────────────

import {
  createMockCallLlm,
  createMockCategoryRepo,
  createMockLlmCallRepo,
  createMockTaskRepo,
  createTestContext,
  createTestSource,
  resetIdSequences,
} from '../fixtures/index.js';

vi.mock('../../../src/prompts/loader.js', () => ({
  loadPromptTemplate: vi.fn().mockReturnValue('mock classifier template'),
  compilePrompt: vi
    .fn()
    .mockImplementation((_t: string, vars: any) => `compiled: ${JSON.stringify(vars)}`),
  computePromptHash: vi.fn().mockReturnValue('abc12345'),
}));

describe('classifying step', () => {
  let mockLlm: ReturnType<typeof createMockCallLlm>;
  let categoryRepo: ReturnType<typeof createMockCategoryRepo>;
  let taskRepo: ReturnType<typeof createMockTaskRepo>;
  let llmCallRepo: ReturnType<typeof createMockLlmCallRepo>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetIdSequences();
    mockLlm = createMockCallLlm();
    categoryRepo = createMockCategoryRepo();
    taskRepo = createMockTaskRepo();
    llmCallRepo = createMockLlmCallRepo();
  });

  it('classifies URL input with urlClassificationSchema', async () => {
    const { executeClassifying } = await import('../../../src/pipeline/steps/classifying.js');
    mockLlm.mockResolvedOutput({
      categoryPath: 'Tech/AI/Tools',
      keywords: ['CLI', 'AI', 'coding'],
    });

    const ctx = createTestContext({
      inputType: 'url',
      content: 'Claude Code is a CLI tool for coding with AI.',
    });

    const result = await executeClassifying(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      categoryRepo,
      taskRepo,
    });

    expect(result.classification).toEqual({
      categoryPath: 'Tech/AI/Tools',
      keywords: ['CLI', 'AI', 'coding'],
    });
    expect(result.inputType).toBe('url');
  });

  it('classifies non-URL input and determines inputType', async () => {
    const { executeClassifying } = await import('../../../src/pipeline/steps/classifying.js');
    mockLlm.mockResolvedOutput({
      inputType: 'opinion',
      categoryPath: 'Tech/AI',
      keywords: ['AI', 'opinion'],
    });

    const source = createTestSource({
      kind: 'user',
      rawContent: 'I think AI tools are becoming essential',
      normalizedUrl: null,
      originalUrl: null,
    });
    const ctx = createTestContext({
      inputType: null,
      content: 'I think AI tools are becoming essential',
      source,
    });

    const result = await executeClassifying(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      categoryRepo,
      taskRepo,
    });

    expect(result.classification).toEqual({
      categoryPath: 'Tech/AI',
      keywords: ['AI', 'opinion'],
    });
    expect(result.inputType).toBe('opinion');
    expect(taskRepo.updateInputType).toHaveBeenCalledWith(ctx.task.id, 'opinion');
  });

  it('preserves ctx.inputType=opinion when LLM returns text', async () => {
    // submit.ts:152 locks `inputType: 'opinion'` for the record_thought
    // intent. Without the guard in classifying, the LLM's text/opinion
    // verdict could demote the user-marked opinion back to 'text', which
    // skips the opinion-only extraction path and silently drops the
    // hashtag tags users explicitly anchored their thought with.
    const { executeClassifying } = await import('../../../src/pipeline/steps/classifying.js');
    mockLlm.mockResolvedOutput({
      inputType: 'text',
      categoryPath: 'Tech/AI',
      keywords: ['AI'],
    });

    const source = createTestSource({
      kind: 'user',
      rawContent: 'just a casual note about AI',
      normalizedUrl: null,
      originalUrl: null,
    });
    const ctx = createTestContext({
      inputType: 'opinion',
      content: 'just a casual note about AI',
      source,
    });

    const result = await executeClassifying(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      categoryRepo,
      taskRepo,
    });

    expect(result.inputType).toBe('opinion');
    expect(taskRepo.updateInputType).not.toHaveBeenCalled();
  });

  it('injects category tree into LLM call', async () => {
    const { executeClassifying } = await import('../../../src/pipeline/steps/classifying.js');
    categoryRepo.getAll = vi.fn().mockReturnValue([
      { id: 1, name: 'Tech', path: '/Tech', parentId: null },
      { id: 2, name: 'AI', path: '/Tech/AI', parentId: 1 },
    ]);
    mockLlm.mockResolvedOutput({
      categoryPath: 'Tech/AI',
      keywords: ['AI'],
    });

    const ctx = createTestContext({ inputType: 'url', content: 'AI article' });
    await executeClassifying(ctx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      categoryRepo,
      taskRepo,
    });

    expect(mockLlm.fn).toHaveBeenCalledTimes(1);
    expect(categoryRepo.getAll).toHaveBeenCalled();
  });

  it('throws PipelineError on LLM failure', async () => {
    const { executeClassifying } = await import('../../../src/pipeline/steps/classifying.js');
    mockLlm.mockRejectedError(new Error('LLM rate limit'));

    const ctx = createTestContext({ inputType: 'url', content: 'test' });

    await expect(
      executeClassifying(ctx, { callLlm: mockLlm.fn, llmCallRepo, categoryRepo, taskRepo }),
    ).rejects.toThrow(PipelineError);
  });

  it('uses correct schema based on inputType', async () => {
    const { executeClassifying } = await import('../../../src/pipeline/steps/classifying.js');

    // URL input
    mockLlm.mockResolvedOutput({
      categoryPath: 'Tech',
      keywords: ['test'],
    });
    const urlCtx = createTestContext({ inputType: 'url', content: 'test' });
    await executeClassifying(urlCtx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      categoryRepo,
      taskRepo,
    });

    const urlCall = mockLlm.fn.mock.calls[0];
    expect(urlCall[0]).toMatchObject({ schema: expect.any(Object) });

    // Non-URL input
    mockLlm.fn.mockClear();
    mockLlm.mockResolvedOutput({
      inputType: 'text',
      categoryPath: 'Tech',
      keywords: ['test'],
    });
    const textCtx = createTestContext({ inputType: null, content: 'test' });
    await executeClassifying(textCtx, {
      callLlm: mockLlm.fn,
      llmCallRepo,
      categoryRepo,
      taskRepo,
    });

    const textCall = mockLlm.fn.mock.calls[0];
    expect(textCall[0]).toMatchObject({ schema: expect.any(Object) });
  });
});
