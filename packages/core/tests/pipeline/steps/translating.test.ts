import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EntityJudgment,
  IndexedPoint,
  RelationOutput,
  ValidationResult,
  VerifierRejection,
} from '../../../src/pipeline/types.js';
import {
  createMockCallLlm,
  createMockLlmCallRepo,
  createTestConfig,
  createTestContext,
  resetIdSequences,
} from '../fixtures/index.js';

vi.mock('../../../src/prompts/loader.js', () => ({
  loadPromptTemplate: vi.fn().mockReturnValue('mock translator template'),
  compilePrompt: vi.fn().mockImplementation((_t: string, vars: any) => JSON.stringify(vars)),
  computePromptHash: vi.fn().mockReturnValue('translator-h'),
}));

describe('translating step', () => {
  let mockLlm: ReturnType<typeof createMockCallLlm>;
  let llmCallRepo: ReturnType<typeof createMockLlmCallRepo>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetIdSequences();
    mockLlm = createMockCallLlm();
    llmCallRepo = createMockLlmCallRepo();
  });

  function buildCtx(opts: { translateOn?: boolean } = {}) {
    const points: IndexedPoint[] = [
      { pointKey: 'kp:0', content: 'A new fact', type: 'fact' },
      { pointKey: 'kp:1', content: 'An opinion', type: 'opinion' },
    ];
    const entityJudgments: EntityJudgment[] = [
      {
        entityKey: 'draft:e1',
        entityName: 'E1',
        resolvedCategoryPath: 'Tech',
        knowledgePointKeys: ['kp:0', 'kp:1'],
        outputMode: 'full_summary',
        description: 'E1 description',
        summary: 'E1 summary',
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          { pointKey: 'kp:1', judgment: 'new', matchedPointId: null, matchedContent: null },
        ],
      },
    ];
    const relations: RelationOutput[] = [
      {
        sourceEntityKey: 'draft:e1',
        targetEntityKey: 'entity:99',
        relationType: 'technical',
        description: 'connected by API',
      },
    ];
    const verifierRejections: VerifierRejection[] = [{ pointKey: 'kp:rej', reason: 'too vague' }];
    const validationResult: ValidationResult = {
      validEntities: entityJudgments,
      droppedPoints: [],
      warnings: [],
      validRelations: relations,
    };

    return createTestContext({
      points,
      entityJudgments,
      verifierRejections,
      validationResult,
      config: createTestConfig({
        language: 'zh',
        translation: { translatePipelineOutput: opts.translateOn ?? true },
      }),
    });
  }

  it('skips when translation is disabled', async () => {
    const { executeTranslating } = await import('../../../src/pipeline/steps/translating.js');
    const ctx = buildCtx({ translateOn: false });
    const result = await executeTranslating(ctx, { callLlm: mockLlm.fn, llmCallRepo });
    expect(mockLlm.fn).not.toHaveBeenCalled();
    expect(result.translations).toEqual({});
  });

  it('skips when there is nothing to translate', async () => {
    const { executeTranslating } = await import('../../../src/pipeline/steps/translating.js');
    const ctx = createTestContext({
      config: createTestConfig({
        translation: { translatePipelineOutput: true },
      }),
      validationResult: { validEntities: [], droppedPoints: [], warnings: [] },
    });
    const result = await executeTranslating(ctx, { callLlm: mockLlm.fn, llmCallRepo });
    expect(mockLlm.fn).not.toHaveBeenCalled();
    expect(result.translations).toEqual({});
  });

  it('maps LLM output back into translations keyed by id', async () => {
    const { executeTranslating } = await import('../../../src/pipeline/steps/translating.js');
    mockLlm.mockResolvedOutput({
      translations: [
        { id: 'p:kp:0', translated: '一个新事实' },
        { id: 'p:kp:1', translated: '一个观点' },
        { id: 'ed:draft:e1', translated: 'E1 的描述' },
        { id: 's:draft:e1', translated: 'E1 的摘要' },
        { id: 'r:draft:e1>entity:99:technical', translated: '通过 API 连接' },
        { id: 'vr:kp:rej', translated: '过于宽泛' },
        // Hallucinated id — must be dropped.
        { id: 'p:does-not-exist', translated: '伪造的翻译' },
        // Empty translation — must be dropped.
        { id: 'p:kp:0', translated: '   ' },
      ],
    });

    const ctx = buildCtx();
    const result = await executeTranslating(ctx, { callLlm: mockLlm.fn, llmCallRepo });

    expect(result.translations).toEqual({
      'p:kp:0': '一个新事实',
      'p:kp:1': '一个观点',
      'ed:draft:e1': 'E1 的描述',
      's:draft:e1': 'E1 的摘要',
      'r:draft:e1>entity:99:technical': '通过 API 连接',
      'vr:kp:rej': '过于宽泛',
    });
    expect(result.translations).not.toHaveProperty('p:does-not-exist');
  });

  it('degrades to empty translations on LLM failure', async () => {
    const { executeTranslating } = await import('../../../src/pipeline/steps/translating.js');
    mockLlm.fn.mockRejectedValueOnce(new Error('rate limit'));
    const ctx = buildCtx();
    const result = await executeTranslating(ctx, { callLlm: mockLlm.fn, llmCallRepo });
    expect(result.translations).toEqual({});
    expect(result.validationWarnings.some((w) => w.includes('rate limit'))).toBe(true);
  });
});
