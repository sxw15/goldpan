import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '../../src/query/search.js';
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

describe('generateQueryAnswer', () => {
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

  const sampleSearchResult: SearchResult = {
    entities: [
      {
        id: 1,
        name: 'React',
        description: 'A JavaScript library for building UIs',
        aliases: ['ReactJS'],
        keywords: ['frontend', 'UI'],
        categoryPaths: ['/Tech/Frontend'],
        lastSourceDate: '2024-01-15',
        points: [
          { id: 10, content: 'React uses a virtual DOM', type: 'fact' },
          { id: 11, content: 'React hooks simplify state management', type: 'fact' },
        ],
        matchedBy: ['fts'],
      },
    ],
  };

  const emptySearchResult: SearchResult = { entities: [] };

  it('synthesizes answer from search results', async () => {
    const { generateQueryAnswer } = await import('../../src/query/answer.js');
    const queryResult = {
      answer: 'React is a JavaScript library that uses a virtual DOM.',
      citedEntityIds: [1],
      citedPointIds: [10],
      confidence: 'high' as const,
    };
    mockLlm.mockResolvedOutput(queryResult);

    const result = await generateQueryAnswer('What is React?', sampleSearchResult, baseDeps());
    expect(result).toEqual(queryResult);
  });

  it('passes query step to callLlm', async () => {
    const { generateQueryAnswer } = await import('../../src/query/answer.js');
    mockLlm.mockResolvedOutput({
      answer: 'test',
      citedEntityIds: [],
      citedPointIds: [],
      confidence: 'low',
    });
    await generateQueryAnswer('test', sampleSearchResult, baseDeps());
    expect(mockLlm.fn).toHaveBeenCalledWith(expect.objectContaining({ step: 'query' }));
  });

  it('handles empty search results (no_data)', async () => {
    const { generateQueryAnswer } = await import('../../src/query/answer.js');
    mockLlm.mockResolvedOutput({
      answer: 'No relevant knowledge found.',
      citedEntityIds: [],
      citedPointIds: [],
      confidence: 'no_data',
    });

    const result = await generateQueryAnswer('Unknown topic?', emptySearchResult, baseDeps());
    expect(result.confidence).toBe('no_data');
    expect(result.citedEntityIds).toEqual([]);
  });

  it('wraps LLM errors with answer_failed message', async () => {
    const { generateQueryAnswer } = await import('../../src/query/answer.js');
    mockLlm.mockRejectedError(new Error('model overloaded'));
    await expect(generateQueryAnswer('some query', sampleSearchResult, baseDeps())).rejects.toThrow(
      /Answer generation failed:.*overloaded/i,
    );
  });

  it('includes relation context in prompt when relations exist', async () => {
    const { compilePrompt } = await import('../../src/prompts/loader.js');
    const { generateQueryAnswer } = await import('../../src/query/answer.js');
    mockLlm.mockResolvedOutput({
      answer: 'React and Vue are both frontend frameworks.',
      citedEntityIds: [1],
      citedPointIds: [10],
      confidence: 'high' as const,
    });

    const relationsContext = '- React → Vue: competitive — "Both are frontend frameworks"';
    await generateQueryAnswer('Compare React and Vue', sampleSearchResult, baseDeps(), {
      relationsContext,
    });

    // compilePrompt is called twice: once for system, once for user template
    const userPromptCall = (compilePrompt as ReturnType<typeof vi.fn>).mock.calls[1];
    const vars = userPromptCall[1];
    expect(vars.relationsContext).toBe(relationsContext);
    expect(vars.hasRelations).toBe(true);
  });

  it('omits relation section when no relations exist', async () => {
    const { compilePrompt } = await import('../../src/prompts/loader.js');
    const { generateQueryAnswer } = await import('../../src/query/answer.js');
    mockLlm.mockResolvedOutput({
      answer: 'React uses a virtual DOM.',
      citedEntityIds: [1],
      citedPointIds: [10],
      confidence: 'high' as const,
    });

    await generateQueryAnswer('What is React?', sampleSearchResult, baseDeps());

    const userPromptCall = (compilePrompt as ReturnType<typeof vi.fn>).mock.calls[1];
    const vars = userPromptCall[1];
    expect(vars.relationsContext).toBe('');
    expect(vars.hasRelations).toBe(false);
  });

  it('passes relationsContext and isSummary to compilePrompt when options provided', async () => {
    const { compilePrompt } = await import('../../src/prompts/loader.js');
    const { generateQueryAnswer } = await import('../../src/query/answer.js');
    mockLlm.mockResolvedOutput({
      answer: 'Analytical answer',
      citedEntityIds: [1],
      citedPointIds: [10],
      confidence: 'high',
    });

    await generateQueryAnswer('Compare A and B', sampleSearchResult, baseDeps(), {
      promptVariant: 'analytical',
      relationsContext: '- A → B: competitive — rivals',
    });

    // System template should receive isAnalytical=true
    expect(compilePrompt).toHaveBeenCalledWith(
      'mock template',
      expect.objectContaining({ isAnalytical: true, isSummary: false }),
    );
    // User template should receive hasRelations=true and relationsContext
    expect(compilePrompt).toHaveBeenCalledWith(
      'mock template',
      expect.objectContaining({
        hasRelations: true,
        relationsContext: '- A → B: competitive — rivals',
        isSummary: false,
      }),
    );
  });

  it('passes isSummary=true for summary variant', async () => {
    const { compilePrompt } = await import('../../src/prompts/loader.js');
    const { generateQueryAnswer } = await import('../../src/query/answer.js');
    mockLlm.mockResolvedOutput({
      answer: 'Summary answer',
      citedEntityIds: [],
      citedPointIds: [],
      confidence: 'medium',
    });

    await generateQueryAnswer('Summarize trends', sampleSearchResult, baseDeps(), {
      promptVariant: 'summary',
    });

    expect(compilePrompt).toHaveBeenCalledWith(
      'mock template',
      expect.objectContaining({ isSummary: true }),
    );
  });

  it('defaults to standard behavior when options not provided', async () => {
    const { compilePrompt } = await import('../../src/prompts/loader.js');
    const { generateQueryAnswer } = await import('../../src/query/answer.js');
    mockLlm.mockResolvedOutput({
      answer: 'Standard answer',
      citedEntityIds: [],
      citedPointIds: [],
      confidence: 'high',
    });

    await generateQueryAnswer('What is React?', sampleSearchResult, baseDeps());

    // User template should NOT have hasRelations=true
    expect(compilePrompt).toHaveBeenCalledWith(
      'mock template',
      expect.not.objectContaining({ hasRelations: true }),
    );
  });
});
