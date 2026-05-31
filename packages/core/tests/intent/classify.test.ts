import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntentDeclaration } from '../../src/plugins/types.js';
import '../helpers/i18n.js';
import {
  createMockCallLlm,
  createMockLlmCallRepo,
  resetIdSequences,
} from '../pipeline/fixtures/index.js';

vi.mock('../../src/prompts/loader.js', () => ({
  loadPromptTemplate: vi.fn().mockReturnValue('mock template'),
  compilePrompt: vi.fn().mockImplementation((_t: string, vars: any) => JSON.stringify(vars)),
  computePromptHash: vi.fn().mockReturnValue('abc12345'),
}));

const TEST_DECLARATIONS: IntentDeclaration[] = [
  {
    name: 'submit_url',
    description: 'URL submission',
    descriptions: { zh: 'URL 提交' },
    examples: ['https://example.com'],
    classificationHints: ['If URL with brief annotation, choose submit_url'],
  },
  {
    name: 'query',
    description: 'Knowledge query',
    classificationHints: ['If asking a question, choose query'],
  },
];

describe('classifyIntent', () => {
  let mockLlm: ReturnType<typeof createMockCallLlm>;
  let llmCallRepo: ReturnType<typeof createMockLlmCallRepo>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetIdSequences();
    mockLlm = createMockCallLlm();
    llmCallRepo = createMockLlmCallRepo();
  });

  it('calls LLM with dynamic schema and returns intent', async () => {
    const { classifyIntent } = await import('../../src/intent/classify.js');
    mockLlm.mockResolvedOutput({ intent: 'query' });

    const result = await classifyIntent('What is React?', {
      callLlm: mockLlm.fn,
      llmCallRepo,
      language: 'en',
      logPayloads: false,
      llmTimeout: 30,
      intentDeclarations: TEST_DECLARATIONS,
    });

    expect(result).toEqual({ intent: 'query' });
    expect(mockLlm.fn).toHaveBeenCalledTimes(1);
  });

  it('passes intentDeclarations sorted alphabetically to prompt', async () => {
    const { classifyIntent } = await import('../../src/intent/classify.js');
    const { compilePrompt } = await import('../../src/prompts/loader.js');
    const mockCompile = vi.mocked(compilePrompt);
    mockLlm.mockResolvedOutput({ intent: 'submit_url' });

    await classifyIntent('test', {
      callLlm: mockLlm.fn,
      llmCallRepo,
      language: 'en',
      logPayloads: false,
      llmTimeout: 30,
      intentDeclarations: TEST_DECLARATIONS,
    });

    // System prompt call (first call) should have sorted intents
    const systemVars = JSON.parse(mockCompile.mock.results[0].value as string);
    expect(systemVars.intents[0].name).toBe('query');
    expect(systemVars.intents[1].name).toBe('submit_url');
    // classificationHints should be flattened from sorted order
    expect(systemVars.classificationHints).toEqual([
      'If asking a question, choose query',
      'If URL with brief annotation, choose submit_url',
    ]);
  });

  it('uses language-specific description when available', async () => {
    const { classifyIntent } = await import('../../src/intent/classify.js');
    const { compilePrompt } = await import('../../src/prompts/loader.js');
    const mockCompile = vi.mocked(compilePrompt);
    mockLlm.mockResolvedOutput({ intent: 'submit_url' });

    await classifyIntent('test', {
      callLlm: mockLlm.fn,
      llmCallRepo,
      language: 'zh',
      logPayloads: false,
      llmTimeout: 30,
      intentDeclarations: TEST_DECLARATIONS,
    });

    const systemVars = JSON.parse(mockCompile.mock.results[0].value as string);
    // submit_url has zh description, should use it
    const submitUrlIntent = systemVars.intents.find((i: any) => i.name === 'submit_url');
    expect(submitUrlIntent.description).toBe('URL 提交');
    // query has no zh description, should use default
    const queryIntent = systemVars.intents.find((i: any) => i.name === 'query');
    expect(queryIntent.description).toBe('Knowledge query');
  });

  it('includes intentNames in promptHash computation', async () => {
    const { classifyIntent } = await import('../../src/intent/classify.js');
    const { computePromptHash } = await import('../../src/prompts/loader.js');
    const mockHash = vi.mocked(computePromptHash);
    mockLlm.mockResolvedOutput({ intent: 'query' });

    await classifyIntent('test', {
      callLlm: mockLlm.fn,
      llmCallRepo,
      language: 'en',
      logPayloads: false,
      llmTimeout: 30,
      intentDeclarations: TEST_DECLARATIONS,
    });

    // computePromptHash should be called with templates + sorted intent names
    expect(mockHash).toHaveBeenCalledWith('mock template', 'mock template', 'query', 'submit_url');
  });

  it('wraps LLM errors with intent.classification_failed message', async () => {
    const { classifyIntent } = await import('../../src/intent/classify.js');
    mockLlm.mockRejectedError(new Error('rate limit'));

    await expect(
      classifyIntent('test', {
        callLlm: mockLlm.fn,
        llmCallRepo,
        language: 'en',
        logPayloads: false,
        llmTimeout: 30,
        intentDeclarations: TEST_DECLARATIONS,
      }),
    ).rejects.toThrow(/rate limit/);
  });
});
