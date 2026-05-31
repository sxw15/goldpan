import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMockCallLlm,
  createMockLlmCallRepo,
  resetIdSequences,
} from '../pipeline/fixtures/index.js';
import '../helpers/i18n.js';

vi.mock('../../src/prompts/loader.js', () => ({
  loadPromptTemplate: vi.fn().mockReturnValue('mock template'),
  compilePrompt: vi.fn().mockImplementation((_t: string, vars: any) => JSON.stringify(vars)),
  computePromptHash: vi.fn().mockReturnValue('abc12345'),
}));

describe('understandQuery', () => {
  let mockLlm: ReturnType<typeof createMockCallLlm>;
  let llmCallRepo: ReturnType<typeof createMockLlmCallRepo>;

  const baseDeps = () => ({
    callLlm: mockLlm.fn,
    llmCallRepo,
    language: 'en' as const,
    logPayloads: false,
    llmTimeout: 30,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetIdSequences();
    mockLlm = createMockCallLlm();
    llmCallRepo = createMockLlmCallRepo();
  });

  it('returns structured search params from LLM', async () => {
    const { understandQuery } = await import('../../src/query/understand.js');
    const understanding = {
      keywords: ['React', 'hooks'],
      hasTimeHint: false,
      categoryHints: ['programming'],
      pointType: 'any' as const,
      sourceKind: 'any' as const,
    };
    mockLlm.mockResolvedOutput(understanding);

    const result = await understandQuery('What do I know about React hooks?', baseDeps());
    expect(result).toEqual(understanding);
  });

  it('passes query_understand step to callLlm', async () => {
    const { understandQuery } = await import('../../src/query/understand.js');
    mockLlm.mockResolvedOutput({
      keywords: [],
      hasTimeHint: false,
      categoryHints: [],
      pointType: 'any',
      sourceKind: 'any',
    });
    await understandQuery('test query', baseDeps());
    expect(mockLlm.fn).toHaveBeenCalledWith(expect.objectContaining({ step: 'query_understand' }));
  });

  it('handles time-hint query', async () => {
    const { understandQuery } = await import('../../src/query/understand.js');
    mockLlm.mockResolvedOutput({
      keywords: ['programming', 'tool'],
      hasTimeHint: true,
      categoryHints: ['programming'],
      pointType: 'any',
      sourceKind: 'external',
    });

    const result = await understandQuery('最近看到的一个编程工具', baseDeps());
    expect(result.hasTimeHint).toBe(true);
    expect(result.sourceKind).toBe('external');
  });

  it('handles opinion-type query', async () => {
    const { understandQuery } = await import('../../src/query/understand.js');
    mockLlm.mockResolvedOutput({
      keywords: ['AI'],
      hasTimeHint: false,
      categoryHints: [],
      pointType: 'opinion',
      sourceKind: 'user',
    });

    const result = await understandQuery('我写的关于AI的想法', baseDeps());
    expect(result.pointType).toBe('opinion');
    expect(result.sourceKind).toBe('user');
  });

  it('wraps LLM errors with understand_failed message', async () => {
    const { understandQuery } = await import('../../src/query/understand.js');
    mockLlm.mockRejectedError(new Error('timeout'));
    await expect(understandQuery('some query', baseDeps())).rejects.toThrow(
      /Query understanding failed:.*timeout/i,
    );
  });
});
