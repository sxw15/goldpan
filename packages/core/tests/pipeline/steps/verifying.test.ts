import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityJudgment, IndexedPoint } from '../../../src/pipeline/types.js';
import {
  createMockCallLlm,
  createMockLlmCallRepo,
  createTestConfig,
  createTestContext,
  resetIdSequences,
} from '../fixtures/index.js';

vi.mock('../../../src/prompts/loader.js', () => ({
  loadPromptTemplate: vi.fn().mockReturnValue('mock verifier template'),
  compilePrompt: vi
    .fn()
    .mockImplementation((_t: string, vars: any) => `compiled: ${JSON.stringify(vars)}`),
  computePromptHash: vi.fn().mockReturnValue('abc12345'),
}));

describe('verifying step', () => {
  let mockLlm: ReturnType<typeof createMockCallLlm>;
  let llmCallRepo: ReturnType<typeof createMockLlmCallRepo>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetIdSequences();
    mockLlm = createMockCallLlm();
    llmCallRepo = createMockLlmCallRepo();
  });

  function makeCtxWithNewPoints(): ReturnType<typeof createTestContext> {
    const points: IndexedPoint[] = [
      { pointKey: 'kp:0', content: 'New fact A', type: 'fact' },
      { pointKey: 'kp:1', content: 'My opinion', type: 'opinion' },
      { pointKey: 'kp:2', content: 'Skipped fact', type: 'fact' },
    ];
    const entityJudgments: EntityJudgment[] = [
      {
        entityKey: 'entity:1',
        entityName: 'E1',
        resolvedCategoryPath: 'Tech',
        knowledgePointKeys: ['kp:0', 'kp:1', 'kp:2'],
        outputMode: 'full_summary',
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'new', matchedPointId: null, matchedContent: null },
          { pointKey: 'kp:1', judgment: 'new', matchedPointId: null, matchedContent: null },
          { pointKey: 'kp:2', judgment: 'skipped', matchedPointId: 10, matchedContent: 'Existing' },
        ],
      },
    ];
    const config = createTestConfig({ llm: { verifierEnabled: true } });
    return createTestContext({
      points,
      entityJudgments,
      config,
      content: 'Source content about facts',
    });
  }

  it('skips verification when verifier is disabled', async () => {
    const { executeVerifying } = await import('../../../src/pipeline/steps/verifying.js');
    const config = createTestConfig({ llm: { verifierEnabled: false } });
    const ctx = createTestContext({ config });

    const result = await executeVerifying(ctx, { callLlm: mockLlm.fn, llmCallRepo });
    expect(mockLlm.fn).not.toHaveBeenCalled();
    expect(result.verifierRejections).toEqual([]);
  });

  it('verifies only new points (skips already-skipped points)', async () => {
    const { executeVerifying } = await import('../../../src/pipeline/steps/verifying.js');
    mockLlm.mockResolvedOutput({
      verifiedPointKeys: ['kp:0', 'kp:1'],
      rejectedPointKeys: [],
    });

    const ctx = makeCtxWithNewPoints();
    const result = await executeVerifying(ctx, { callLlm: mockLlm.fn, llmCallRepo });

    expect(result.verifierRejections).toEqual([]);
    const callArgs = mockLlm.fn.mock.calls[0][0];
    expect(callArgs.prompt).toContain('kp:0');
    expect(callArgs.prompt).toContain('kp:1');
    expect(callArgs.prompt).not.toContain('kp:2');
  });

  it('records rejections from verifier', async () => {
    const { executeVerifying } = await import('../../../src/pipeline/steps/verifying.js');
    mockLlm.mockResolvedOutput({
      verifiedPointKeys: ['kp:1'],
      rejectedPointKeys: [
        { pointKey: 'kp:0', reason: 'Original content does not mention this fact' },
      ],
    });

    const ctx = makeCtxWithNewPoints();
    const result = await executeVerifying(ctx, { callLlm: mockLlm.fn, llmCallRepo });

    expect(result.verifierRejections).toHaveLength(1);
    expect(result.verifierRejections[0]).toEqual({
      pointKey: 'kp:0',
      reason: 'Original content does not mention this fact',
    });
  });

  it('handles mutual exclusion: same pointKey in both verified and rejected → rejected wins', async () => {
    const { executeVerifying } = await import('../../../src/pipeline/steps/verifying.js');
    mockLlm.mockResolvedOutput({
      verifiedPointKeys: ['kp:0', 'kp:1'],
      rejectedPointKeys: [{ pointKey: 'kp:0', reason: 'conflicting result' }],
    });

    const ctx = makeCtxWithNewPoints();
    const result = await executeVerifying(ctx, { callLlm: mockLlm.fn, llmCallRepo });

    expect(result.verifierRejections).toHaveLength(1);
    expect(result.verifierRejections[0].pointKey).toBe('kp:0');
    expect(result.validationWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining('kp:0')]),
    );
  });

  it('degrades gracefully on LLM failure (skip verification, add warning)', async () => {
    const { executeVerifying } = await import('../../../src/pipeline/steps/verifying.js');
    mockLlm.mockRejectedError(new Error('LLM timeout'));

    const ctx = makeCtxWithNewPoints();
    const result = await executeVerifying(ctx, { callLlm: mockLlm.fn, llmCallRepo });

    expect(result.verifierRejections).toEqual([]);
    expect(result.validationWarnings.some((w) => w.includes('Verification round'))).toBe(true);
  });

  it('filters out unknown pointKeys returned by verifier LLM', async () => {
    const { executeVerifying } = await import('../../../src/pipeline/steps/verifying.js');
    mockLlm.mockResolvedOutput({
      verifiedPointKeys: ['kp:0', 'kp:hallucinated'],
      rejectedPointKeys: [
        { pointKey: 'kp:1', reason: 'Original content does not mention' },
        { pointKey: 'kp:ghost', reason: 'also hallucinated' },
      ],
    });

    const ctx = makeCtxWithNewPoints();
    const result = await executeVerifying(ctx, { callLlm: mockLlm.fn, llmCallRepo });

    // kp:ghost should be filtered out of rejections
    expect(result.verifierRejections).toHaveLength(1);
    expect(result.verifierRejections[0].pointKey).toBe('kp:1');

    // Warnings should mention both hallucinated keys
    expect(result.validationWarnings.some((w) => w.includes('kp:hallucinated'))).toBe(true);
    expect(result.validationWarnings.some((w) => w.includes('kp:ghost'))).toBe(true);
  });

  it('filters out known-but-non-new pointKey from verifier output', async () => {
    const { executeVerifying } = await import('../../../src/pipeline/steps/verifying.js');
    // kp:2 is 'skipped' (not 'new'), so verifier should not judge it
    mockLlm.mockResolvedOutput({
      verifiedPointKeys: ['kp:0'],
      rejectedPointKeys: [
        { pointKey: 'kp:1', reason: 'Original content does not mention' },
        { pointKey: 'kp:2', reason: 'also rejected' }, // kp:2 is skipped, not new!
      ],
    });

    const ctx = makeCtxWithNewPoints();
    const result = await executeVerifying(ctx, { callLlm: mockLlm.fn, llmCallRepo });

    // kp:2 should be filtered out (it's not in newPointKeys)
    expect(result.verifierRejections).toHaveLength(1);
    expect(result.verifierRejections[0].pointKey).toBe('kp:1');

    // Warning for kp:2 being non-target
    expect(result.validationWarnings.some((w) => w.includes('kp:2'))).toBe(true);
  });

  it('skips verification when no new points exist', async () => {
    const { executeVerifying } = await import('../../../src/pipeline/steps/verifying.js');
    const entityJudgments: EntityJudgment[] = [
      {
        entityKey: 'entity:1',
        entityName: 'E1',
        resolvedCategoryPath: 'Tech',
        knowledgePointKeys: ['kp:0'],
        outputMode: 'full_summary',
        pointJudgments: [
          { pointKey: 'kp:0', judgment: 'skipped', matchedPointId: 10, matchedContent: 'Existing' },
        ],
      },
    ];
    const config = createTestConfig({ llm: { verifierEnabled: true } });
    const ctx = createTestContext({ entityJudgments, config });

    const _result = await executeVerifying(ctx, { callLlm: mockLlm.fn, llmCallRepo });
    expect(mockLlm.fn).not.toHaveBeenCalled();
  });

  it('warns about omitted pointKeys from verifier response', async () => {
    const { executeVerifying } = await import('../../../src/pipeline/steps/verifying.js');
    // Verifier only returns kp:0 as verified, omits kp:1 entirely
    mockLlm.mockResolvedOutput({
      verifiedPointKeys: ['kp:0'],
      rejectedPointKeys: [],
    });

    const ctx = makeCtxWithNewPoints();
    const result = await executeVerifying(ctx, { callLlm: mockLlm.fn, llmCallRepo });

    // kp:1 is a new point but not in verified or rejected — should warn
    expect(
      result.validationWarnings.some((w) => w.includes('kp:1') && w.includes('did not return')),
    ).toBe(true);
    // kp:0 was verified, no warning for it
    expect(
      result.validationWarnings.some((w) => w.includes('kp:0') && w.includes('did not return')),
    ).toBe(false);
    // Omitted points are accepted (not rejected)
    expect(result.verifierRejections).toHaveLength(0);
  });
});
