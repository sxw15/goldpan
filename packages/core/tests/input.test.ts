import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoldpanConfig } from '../src/config/index.js';
import { SqliteConversationRepository } from '../src/db/repositories/conversation.repository.js';
import { PipelineError } from '../src/errors.js';
import { PluginRegistry } from '../src/plugins/registry.js';
import type { IntentPlugin } from '../src/plugins/types.js';
import type { SubmitResult } from '../src/submit.js';
import { createTestDB } from './helpers/test-db.js';
import './helpers/i18n.js';
import {
  createMockCallLlm,
  createMockLlmCallRepo,
  createTestConfig,
  resetIdSequences,
} from './pipeline/fixtures/index.js';

// Mock prompts/loader (used by classifyIntent and queryKnowledge internals)
vi.mock('../src/prompts/loader.js', () => ({
  loadPromptTemplate: vi.fn().mockReturnValue('mock template'),
  compilePrompt: vi.fn().mockImplementation((_t: string, vars: any) => JSON.stringify(vars)),
  computePromptHash: vi.fn().mockReturnValue('abc12345'),
}));

// Mock submit module (used by URL short-circuit path)
vi.mock('../src/submit.js', () => ({
  submitInput: vi.fn(),
  submitText: vi.fn(),
}));

// Mock intent classifier
vi.mock('../src/intent/classify.js', () => ({
  classifyIntent: vi.fn(),
}));

// Mock query module (for MAX_QUERY_LENGTH constant)
vi.mock('../src/query/index.js', () => ({
  MAX_QUERY_LENGTH: 2000,
  queryKnowledge: vi.fn(),
}));

function createTestRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  const submitPlugin: IntentPlugin = {
    name: 'intent-submit',
    version: '1.0.0',
    type: 'intent',
    description: 'Test submit plugin',
    intents: [
      { name: 'submit_url', description: 'URL submission', resultTypes: ['submit'] },
      { name: 'submit_text', description: 'Text submission', resultTypes: ['submit'] },
      { name: 'record_thought', description: 'Record thought', resultTypes: ['submit'] },
    ],
    async execute(intent, input, ctx) {
      const { submitInput, submitText } = await import('../src/submit.js');
      if (intent === 'record_thought') {
        const result = await submitText(input, {
          db: ctx.db,
          submissionLog: ctx.repos.submissionLog,
          maxTextInputLength: ctx.config.maxTextInputLength,
        });
        return { type: 'submit', result };
      }
      const result = await submitInput(input, {
        db: ctx.db,
        submissionLog: ctx.repos.submissionLog,
        maxTextInputLength: ctx.config.maxTextInputLength,
      });
      return { type: 'submit', result };
    },
  };

  const queryPlugin: IntentPlugin = {
    name: 'intent-query',
    version: '1.0.0',
    type: 'intent',
    description: 'Test query plugin',
    intents: [
      {
        name: 'query',
        description: 'Knowledge query',
        maxInputLength: 2000,
        resultTypes: ['query'],
      },
    ],
    async execute(_intent, input, ctx) {
      const { queryKnowledge } = await import('../src/query/index.js');
      const result = await queryKnowledge(input, {
        db: ctx.db,
        callLlm: ctx.callLlm,
        llmCallRepo: ctx.llmCallRepo,
        language: ctx.language,
        logPayloads: ctx.logPayloads,
        llmTimeout: ctx.llmTimeout,
      });
      return { type: 'query', result, query: input };
    },
  };

  const unknownPlugin: IntentPlugin = {
    name: 'intent-unknown',
    version: '1.0.0',
    type: 'intent',
    description: 'Test unknown plugin',
    intents: [
      {
        name: 'unknown_intent',
        description: 'Unknown intent for testing',
        resultTypes: ['content', 'action', 'clarify'],
      },
    ],
    async execute(_intent, _input, _ctx) {
      throw new TypeError('unexpected null');
    },
  };

  registry.register(submitPlugin);
  registry.register(queryPlugin);
  registry.register(unknownPlugin);
  return registry;
}

describe('handleInput', () => {
  let mockLlm: ReturnType<typeof createMockCallLlm>;
  let llmCallRepo: ReturnType<typeof createMockLlmCallRepo>;
  let pluginRegistry: PluginRegistry;
  let config: GoldpanConfig;

  const baseDeps = () => ({
    db: {} as any,
    callLlm: mockLlm.fn,
    pluginRegistry,
    config,
    repos: {
      llmCall: llmCallRepo,
      submissionLog: undefined as any,
      knowledge: {} as any,
      category: {} as any,
      notes: {} as any,
      source: {} as any,
      conversation: {} as any,
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetIdSequences();
    mockLlm = createMockCallLlm();
    llmCallRepo = createMockLlmCallRepo();
    pluginRegistry = createTestRegistry();
    config = createTestConfig();
  });

  it('returns error for empty input', async () => {
    const { handleInput } = await import('../src/input.js');
    const result = await handleInput('', baseDeps());
    expect(result).toEqual({
      type: 'error',
      code: 'input_empty',
      message: 'Input is empty',
    });
  });

  it('returns error for whitespace-only input', async () => {
    const { handleInput } = await import('../src/input.js');
    const result = await handleInput('   ', baseDeps());
    expect(result).toEqual({
      type: 'error',
      code: 'input_empty',
      message: 'Input is empty',
    });
  });

  it('short-circuits bare URL to submit without LLM', async () => {
    const { handleInput } = await import('../src/input.js');
    const { submitInput } = await import('../src/submit.js');
    const mockSubmit = vi.mocked(submitInput);
    const submitResult: SubmitResult = {
      status: 'accepted',
      taskId: 1,
      sourceId: 1,
      warnings: [],
    };
    mockSubmit.mockResolvedValue(submitResult);

    const result = await handleInput('https://example.com', baseDeps());
    expect(result).toEqual({ type: 'submit', result: submitResult });
    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });

  it('routes submit_url intent to plugin execute', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    const { submitInput } = await import('../src/submit.js');
    const mockClassify = vi.mocked(classifyIntent);
    const mockSubmit = vi.mocked(submitInput);

    mockClassify.mockResolvedValue({ decision: 'execute', intent: 'submit_url', relatedTo: null });
    const submitResult: SubmitResult = {
      status: 'accepted',
      taskId: 2,
      sourceId: 2,
      warnings: [],
    };
    mockSubmit.mockResolvedValue(submitResult);

    const result = await handleInput(
      'This is a very long annotation about the article https://example.com/article',
      baseDeps(),
    );
    expect(result).toEqual({ type: 'submit', result: submitResult });
    expect(mockClassify).toHaveBeenCalledTimes(1);
  });

  it('routes submit_text intent to plugin execute', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    const { submitInput } = await import('../src/submit.js');
    const mockClassify = vi.mocked(classifyIntent);
    const mockSubmit = vi.mocked(submitInput);

    mockClassify.mockResolvedValue({ decision: 'execute', intent: 'submit_text', relatedTo: null });
    const submitResult: SubmitResult = {
      status: 'accepted',
      taskId: 3,
      sourceId: 3,
      warnings: [],
    };
    mockSubmit.mockResolvedValue(submitResult);

    const result = await handleInput('Apple released a new macbook today', baseDeps());
    expect(result).toEqual({ type: 'submit', result: submitResult });
  });

  it('routes record_thought intent to submitText (preserves opinion even with URL)', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    const { submitText } = await import('../src/submit.js');
    const mockClassify = vi.mocked(classifyIntent);
    const mockSubmitText = vi.mocked(submitText);

    mockClassify.mockResolvedValue({
      decision: 'execute',
      intent: 'record_thought',
      relatedTo: null,
    });
    const submitResult: SubmitResult = {
      status: 'accepted',
      taskId: 4,
      sourceId: 4,
      warnings: [],
    };
    mockSubmitText.mockResolvedValue(submitResult);

    const result = await handleInput('I think AI is going to change everything', baseDeps());
    expect(result).toEqual({ type: 'submit', result: submitResult });
    expect(mockSubmitText).toHaveBeenCalledTimes(1);
  });

  it('record_thought with URL in input still calls submitText (not submitInput)', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    const { submitInput: mockSubmitInputFn, submitText } = await import('../src/submit.js');
    const mockClassify = vi.mocked(classifyIntent);
    const mockSubmitText = vi.mocked(submitText);
    const mockSubmitInput = vi.mocked(mockSubmitInputFn);

    mockClassify.mockResolvedValue({
      decision: 'execute',
      intent: 'record_thought',
      relatedTo: null,
    });
    const submitResult: SubmitResult = {
      status: 'accepted',
      taskId: 5,
      sourceId: 5,
      warnings: [],
    };
    mockSubmitText.mockResolvedValue(submitResult);

    const inputWithUrl =
      'I think this article https://example.com/ai-future is overblown — AI hype will fade';
    const result = await handleInput(inputWithUrl, baseDeps());
    expect(result).toEqual({ type: 'submit', result: submitResult });
    expect(mockSubmitText).toHaveBeenCalledWith(inputWithUrl, expect.any(Object));
    expect(mockSubmitInput).not.toHaveBeenCalled();
  });

  it('routes query intent to plugin execute', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    const { queryKnowledge } = await import('../src/query/index.js');
    const mockClassify = vi.mocked(classifyIntent);
    const mockQuery = vi.mocked(queryKnowledge);

    mockClassify.mockResolvedValue({ decision: 'execute', intent: 'query', relatedTo: null });
    const queryResult = {
      answer: 'React is a JS library.',
      citedEntityIds: [1],
      citedPointIds: [10],
      confidence: 'high' as const,
    };
    mockQuery.mockResolvedValue(queryResult);

    const result = await handleInput('What is React?', baseDeps());
    expect(result).toEqual({
      type: 'query',
      result: queryResult,
      query: 'What is React?',
    });
  });

  it('returns intent_failed error when classifyIntent throws', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    const mockClassify = vi.mocked(classifyIntent);

    mockClassify.mockRejectedValue(new Error('rate limit exceeded'));

    const result = await handleInput('some ambiguous text input', baseDeps());
    expect(result).toEqual({
      type: 'error',
      code: 'intent_failed',
      message: 'Intent classification failed',
    });
  });

  it('returns query_failed error when queryKnowledge throws', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    const { queryKnowledge } = await import('../src/query/index.js');
    const mockClassify = vi.mocked(classifyIntent);
    const mockQuery = vi.mocked(queryKnowledge);

    mockClassify.mockResolvedValue({ decision: 'execute', intent: 'query', relatedTo: null });
    mockQuery.mockRejectedValue(new Error('model overloaded'));

    const result = await handleInput('What is React?', baseDeps());
    expect(result).toEqual({
      type: 'error',
      code: 'query_failed',
      message: 'Plugin execution failed',
    });
  });

  it('returns submit_failed error when URL short-circuit submitInput throws', async () => {
    const { handleInput } = await import('../src/input.js');
    const { submitInput } = await import('../src/submit.js');
    const mockSubmit = vi.mocked(submitInput);

    mockSubmit.mockRejectedValue(new Error('db write failed'));

    const result = await handleInput('https://example.com', baseDeps());
    expect(result).toEqual({
      type: 'error',
      code: 'submit_failed',
      message: 'Submit failed',
    });
  });

  it('returns submit_failed error when intent-routed submitInput throws', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    const { submitInput } = await import('../src/submit.js');
    const mockClassify = vi.mocked(classifyIntent);
    const mockSubmit = vi.mocked(submitInput);

    mockClassify.mockResolvedValue({ decision: 'execute', intent: 'submit_text', relatedTo: null });
    mockSubmit.mockRejectedValue(new Error('constraint violation'));

    const result = await handleInput('Some text content to submit', baseDeps());
    expect(result).toEqual({
      type: 'error',
      code: 'submit_failed',
      message: 'Plugin execution failed',
    });
  });

  it('returns text_too_long error when input exceeds maxTextInputLength', async () => {
    const { handleInput } = await import('../src/input.js');
    const deps = baseDeps();
    deps.config = { ...deps.config, maxTextInputLength: 100 };

    const result = await handleInput('x'.repeat(101), deps);
    expect(result).toEqual({
      type: 'error',
      code: 'text_too_long',
      message: 'Input too long',
    });
  });

  it('sends full input to intent classifier when intentClassificationCharLimit is 0', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    const { queryKnowledge } = await import('../src/query/index.js');
    const mockClassify = vi.mocked(classifyIntent);
    const mockQuery = vi.mocked(queryKnowledge);

    mockClassify.mockResolvedValue({ decision: 'execute', intent: 'query', relatedTo: null });
    mockQuery.mockResolvedValue({ answer: 'ok', confidence: 'high' });

    const long = 'c'.repeat(600);
    await handleInput(long, baseDeps());

    expect(mockClassify).toHaveBeenCalledWith(long, expect.any(Object));
  });

  it('truncates intent classifier input when intentClassificationCharLimit > 0', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    const { queryKnowledge } = await import('../src/query/index.js');
    const mockClassify = vi.mocked(classifyIntent);
    const mockQuery = vi.mocked(queryKnowledge);

    mockClassify.mockResolvedValue({ decision: 'execute', intent: 'query', relatedTo: null });
    mockQuery.mockResolvedValue({ answer: 'ok', confidence: 'high' });

    const deps = baseDeps();
    deps.config = { ...deps.config, intentClassificationCharLimit: 100 };
    const long = 'd'.repeat(500);
    await handleInput(long, deps);

    expect(mockClassify).toHaveBeenCalledWith('d'.repeat(100), expect.any(Object));
  });

  it('returns input_too_long_for_intent when input exceeds declaration maxInputLength', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    const { queryKnowledge } = await import('../src/query/index.js');
    vi.mocked(classifyIntent).mockResolvedValue({
      decision: 'execute',
      intent: 'query',
      relatedTo: null,
    });
    const mockQuery = vi.mocked(queryKnowledge);

    const longQuery = 'q'.repeat(2001);
    const result = await handleInput(longQuery, baseDeps());

    expect(result).toEqual({
      type: 'error',
      code: 'input_too_long_for_intent',
      message: expect.stringContaining('max 2000'),
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns unknown_intent when no plugin handles the classified intent', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    vi.mocked(classifyIntent).mockResolvedValue({
      decision: 'execute',
      intent: 'nonexistent_intent',
      relatedTo: null,
    });

    const result = await handleInput('some input', baseDeps());
    expect(result).toEqual({
      type: 'error',
      code: 'unknown_intent',
      message: expect.stringContaining('nonexistent_intent'),
    });
  });

  it('returns plugin_error for non-PipelineError plugin exceptions', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    vi.mocked(classifyIntent).mockResolvedValue({
      decision: 'execute',
      intent: 'unknown_intent',
      relatedTo: null,
    });

    const result = await handleInput(
      'Some text that gets classified as unknown intent',
      baseDeps(),
    );
    expect(result).toEqual({
      type: 'error',
      code: 'plugin_error',
      message: 'Plugin execution failed',
    });
  });

  it('preserves PipelineError kind as specific error code from plugin', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    vi.mocked(classifyIntent).mockResolvedValue({
      decision: 'execute',
      intent: 'query',
      relatedTo: null,
    });

    const { queryKnowledge } = await import('../src/query/index.js');
    vi.mocked(queryKnowledge).mockRejectedValue(
      new PipelineError('LLM timeout', 'query', 'timeout'),
    );

    const result = await handleInput('What is React?', baseDeps());
    expect(result).toEqual({
      type: 'error',
      code: 'query_failed',
      message: 'Plugin execution failed',
    });
  });

  it('passes intentDeclarations from pluginRegistry to classifyIntent', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    const { queryKnowledge } = await import('../src/query/index.js');
    const mockClassify = vi.mocked(classifyIntent);
    vi.mocked(queryKnowledge).mockResolvedValue({ answer: 'ok', confidence: 'high' });
    mockClassify.mockResolvedValue({ decision: 'execute', intent: 'query', relatedTo: null });

    await handleInput('What is React?', baseDeps());

    expect(mockClassify).toHaveBeenCalledWith(
      'What is React?',
      expect.objectContaining({
        intentDeclarations: expect.arrayContaining([
          expect.objectContaining({ name: 'submit_url' }),
          expect.objectContaining({ name: 'query' }),
        ]),
      }),
    );
  });

  it('returns plugin_error for plugin returning invalid result type', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    vi.mocked(classifyIntent).mockResolvedValue({
      decision: 'execute',
      intent: 'submit_url',
      relatedTo: null,
    });

    // Mutate the submit plugin to return an invalid result
    const deps = baseDeps();
    const plugin = deps.pluginRegistry.findIntentHandler('submit_url')!;
    const origExecute = plugin.execute;
    plugin.execute = vi.fn().mockResolvedValue({ type: 'bogus', data: 123 });

    const result = await handleInput('something', deps);
    expect(result).toEqual({
      type: 'error',
      code: 'plugin_error',
      message: expect.stringContaining('bogus'),
    });

    plugin.execute = origExecute;
  });

  it('rejects plugin result type not in declaration resultTypes', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    vi.mocked(classifyIntent).mockResolvedValue({
      decision: 'execute',
      intent: 'submit_url',
      relatedTo: null,
    });

    // submit_url declares resultTypes: ['submit'], so 'content' should be rejected
    const deps = baseDeps();
    const plugin = deps.pluginRegistry.findIntentHandler('submit_url')!;
    const origExecute = plugin.execute;
    plugin.execute = vi.fn().mockResolvedValue({
      type: 'content',
      text: 'should be rejected',
    });

    const result = await handleInput('something', deps);
    expect(result).toEqual({
      type: 'error',
      code: 'plugin_error',
      message: expect.stringContaining('content'),
    });

    plugin.execute = origExecute;
  });

  it('passes through content result from plugin', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    vi.mocked(classifyIntent).mockResolvedValue({
      decision: 'execute',
      intent: 'unknown_intent',
      relatedTo: null,
    });

    const deps = baseDeps();
    const plugin = deps.pluginRegistry.findIntentHandler('unknown_intent')!;
    const origExecute = plugin.execute;
    plugin.execute = vi.fn().mockResolvedValue({
      type: 'content',
      text: 'Here is some info',
      format: 'markdown',
    });

    const result = await handleInput('something', deps);
    expect(result).toEqual({
      type: 'content',
      text: 'Here is some info',
      format: 'markdown',
    });

    plugin.execute = origExecute;
  });

  it('passes through clarify result from plugin', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    vi.mocked(classifyIntent).mockResolvedValue({
      decision: 'execute',
      intent: 'unknown_intent',
      relatedTo: null,
    });

    const deps = baseDeps();
    const plugin = deps.pluginRegistry.findIntentHandler('unknown_intent')!;
    const origExecute = plugin.execute;
    plugin.execute = vi.fn().mockResolvedValue({
      type: 'clarify',
      question: 'Which format do you prefer?',
      options: ['JSON', 'CSV'],
    });

    const result = await handleInput('something', deps);
    expect(result).toEqual({
      type: 'clarify',
      question: 'Which format do you prefer?',
      options: ['JSON', 'CSV'],
    });

    plugin.execute = origExecute;
  });

  // ─── forcedIntent ───────────────────────────────────────────

  describe('handleInput forcedIntent', () => {
    it('skips classifier and routes directly to named plugin', async () => {
      const { handleInput } = await import('../src/input.js');
      const { classifyIntent } = await import('../src/intent/classify.js');
      const { queryKnowledge } = await import('../src/query/index.js');
      const mockClassify = vi.mocked(classifyIntent);
      const mockQuery = vi.mocked(queryKnowledge);

      // classifyIntent should NOT be called
      mockClassify.mockRejectedValue(new Error('should not be called'));

      const queryResult = {
        answer: 'Forced answer.',
        citedEntityIds: [1],
        citedPointIds: [10],
        confidence: 'high' as const,
      };
      mockQuery.mockResolvedValue(queryResult);

      const result = await handleInput('what is X?', {
        ...baseDeps(),
        forcedIntent: 'query',
      });

      expect(result).toEqual({ type: 'query', result: queryResult, query: 'what is X?' });
      expect(mockClassify).not.toHaveBeenCalled();
    });

    it('returns unknown_intent for unregistered forcedIntent', async () => {
      const { handleInput } = await import('../src/input.js');

      const result = await handleInput('hello', {
        ...baseDeps(),
        forcedIntent: 'nonexistent_intent',
      });

      expect(result).toEqual({
        type: 'error',
        code: 'unknown_intent',
        message: expect.stringContaining('nonexistent_intent'),
      });
    });

    it('overrides URL short-circuit when forcedIntent is set', async () => {
      const { handleInput } = await import('../src/input.js');
      const { classifyIntent } = await import('../src/intent/classify.js');
      const { submitInput: mockSubmitInputFn, submitText } = await import('../src/submit.js');
      const mockClassify = vi.mocked(classifyIntent);
      const mockSubmitInput = vi.mocked(mockSubmitInputFn);
      const mockSubmitText = vi.mocked(submitText);

      // Should NOT be called — neither classifier nor URL short-circuit
      mockClassify.mockRejectedValue(new Error('should not be called'));

      const submitResult: SubmitResult = {
        status: 'accepted',
        taskId: 99,
        sourceId: 99,
        warnings: [],
      };
      mockSubmitText.mockResolvedValue(submitResult);

      // Bare URL that would normally short-circuit to submit_url
      const result = await handleInput('https://x.com', {
        ...baseDeps(),
        forcedIntent: 'record_thought',
      });

      expect(result).toEqual({ type: 'submit', result: submitResult });
      // URL short-circuit submitInput should NOT have been called
      expect(mockSubmitInput).not.toHaveBeenCalled();
      // classifier should NOT have been called
      expect(mockClassify).not.toHaveBeenCalled();
      // record_thought plugin calls submitText
      expect(mockSubmitText).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── P2 v2 decision dispatch（execute / wait / clarify）────────
//
// 本 describe 块只针对 P2 改写新加的 decision 分支，全部走 DI（deps.classifyIntent）
// 注入而非 vi.mock，对齐 spec §"关键设计取舍" 第 11 条。其余通用错误处理 / forcedIntent /
// URL short-circuit 由上方 describe('handleInput') 覆盖（迁移成本：那批 mock 走 vi.mock
// 路径，结果一致，留作回归基线）。
describe('handleInput v2 decision dispatch', () => {
  let mockLlm: ReturnType<typeof createMockCallLlm>;
  let llmCallRepo: ReturnType<typeof createMockLlmCallRepo>;
  let pluginRegistry: PluginRegistry;
  let config: GoldpanConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    resetIdSequences();
    mockLlm = createMockCallLlm();
    llmCallRepo = createMockLlmCallRepo();
    pluginRegistry = createTestRegistry();
    config = createTestConfig();
  });

  function makeDecisionDeps(overrides: Record<string, any> = {}) {
    return {
      db: {} as any,
      callLlm: mockLlm.fn,
      pluginRegistry,
      config,
      repos: {
        llmCall: llmCallRepo,
        submissionLog: undefined as any,
        knowledge: {} as any,
        category: {} as any,
        notes: {} as any,
        source: {} as any,
        conversation: {
          markBufferedWait: vi.fn().mockReturnValue(true),
        } as any,
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
      conversation: {
        sessionKey: 'test:1',
        conversationId: 1,
        channelId: 'test',
        recentMessages: [{ id: 100, role: 'user' as const, content: 'cur', createdAt: new Date() }],
        messageWindowSize: 6,
        startedAt: new Date(),
      },
      currentUserMessageId: 100,
      ...overrides,
    };
  }

  it('decision=execute → 走 plugin（路径与 legacy 等价）', async () => {
    const { handleInput } = await import('../src/input.js');
    const { submitInput } = await import('../src/submit.js');
    const fakeClassify = vi.fn().mockResolvedValue({
      decision: 'execute',
      intent: 'submit_url',
      relatedTo: null,
    });
    const submitResult: SubmitResult = {
      status: 'accepted',
      taskId: 200,
      sourceId: 200,
      warnings: [],
    };
    vi.mocked(submitInput).mockResolvedValue(submitResult);

    const deps = makeDecisionDeps({ classifyIntent: fakeClassify });
    const result = await handleInput(
      'long enough input that escapes URL short-circuit https://example.com/foo',
      deps,
    );
    expect(result.type).toBe('submit');
    expect(fakeClassify).toHaveBeenCalledTimes(1);
  });

  it('decision=wait → markBufferedWait + 返回 wait result', async () => {
    const { handleInput } = await import('../src/input.js');
    const fakeClassify = vi.fn().mockResolvedValue({
      decision: 'wait',
      intent: 'create_note',
      fallbackIntent: 'create_note',
      maxWaitMs: 30000,
      waitReason: 'incomplete_command',
      relatedTo: null,
    });
    const deps = makeDecisionDeps({ classifyIntent: fakeClassify });
    const markSpy = deps.repos.conversation.markBufferedWait;

    const result = await handleInput('明天那个...', deps);
    expect(result.type).toBe('wait');
    if (result.type === 'wait') {
      expect(result.bufferedMessageId).toBe(100);
      expect(result.fallbackIntent).toBe('create_note');
      expect(result.waitReasonKey).toBe('incomplete_command');
      expect(result.maxWaitMs).toBe(30000);
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    }
    expect(markSpy).toHaveBeenCalledWith(
      100,
      expect.any(Number),
      expect.objectContaining({
        decision: 'wait',
        intent: 'create_note',
        fallbackIntent: 'create_note',
        waitReason: 'incomplete_command',
      }),
      // P3: 顶层 user-visible waitReasonKey 跟随 classifierDecision.waitReason
      { waitReasonKey: 'incomplete_command' },
    );
  });

  it('decision=wait + markBufferedWait CAS 失败 → intent_failed error', async () => {
    const { handleInput } = await import('../src/input.js');
    const fakeClassify = vi.fn().mockResolvedValue({
      decision: 'wait',
      intent: 'create_note',
      fallbackIntent: 'create_note',
      maxWaitMs: 30000,
      waitReason: 'incomplete_command',
      relatedTo: null,
    });
    const deps = makeDecisionDeps({ classifyIntent: fakeClassify });
    (deps.repos.conversation.markBufferedWait as any).mockReturnValue(false);

    const result = await handleInput('明天...', deps);
    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.code).toBe('intent_failed');
    }
  });

  it('decision=wait + 无 currentUserMessageId（CLI 场景）→ 降级跑 fallbackIntent', async () => {
    // CLI 场景下没有 conversation_messages.id 可挂起 —— 把 wait 降级为立即执行
    // fallbackIntent，避免悬空。校验 fallback 走完整 plugin 路径并返回业务 result。
    const { handleInput } = await import('../src/input.js');
    const { submitInput } = await import('../src/submit.js');
    const fakeClassify = vi.fn().mockResolvedValue({
      decision: 'wait',
      intent: 'submit_url',
      fallbackIntent: 'submit_url',
      maxWaitMs: 30000,
      waitReason: 'incomplete_command',
      relatedTo: null,
    });
    const submitResult: SubmitResult = {
      status: 'accepted',
      taskId: 201,
      sourceId: 201,
      warnings: [],
    };
    vi.mocked(submitInput).mockResolvedValue(submitResult);

    const deps = makeDecisionDeps({
      classifyIntent: fakeClassify,
      currentUserMessageId: undefined,
      conversation: undefined,
    });
    const markSpy = deps.repos.conversation.markBufferedWait;

    const result = await handleInput(
      'long enough input that escapes URL short-circuit https://example.com/x',
      deps,
    );
    // wait 降级跑 fallbackIntent (submit_url) → submit plugin
    expect(result.type).toBe('submit');
    expect(markSpy).not.toHaveBeenCalled();
  });

  it('decision=clarify → 同时填 keyed 和 legacy 字段', async () => {
    const { handleInput } = await import('../src/input.js');
    const fakeClassify = vi.fn().mockResolvedValue({
      decision: 'clarify',
      clarifyQuestionKey: 'ambiguous_intent',
      clarifyOptions: [{ intentKey: 'create_note' }, { intentKey: 'submit_text' }],
      relatedTo: null,
    });
    const deps = makeDecisionDeps({ classifyIntent: fakeClassify });
    const result = await handleInput('记一下', deps);
    expect(result.type).toBe('clarify');
    if (result.type === 'clarify') {
      // P2 keyed 字段（UI 优先消费）
      expect(result.questionKey).toBe('ambiguous_intent');
      expect(result.structuredOptions).toHaveLength(2);
      expect(result.structuredOptions?.[0]?.intentKey).toBe('create_note');
      // legacy 兼容字段（外部 plugin / 老 UI 兜底消费）
      // Task 15 之前 i18n key 缺，t() 降级返 key 本身 → 非空字符串。
      expect(result.question).toBeTruthy();
      expect(result.options).toHaveLength(2);
      expect(typeof result.options?.[0]).toBe('string');
    }
  });

  it('decision=execute 时 linkedSourceId / noteSubtype / currentUserMessageId 透传到 context', async () => {
    const { handleInput } = await import('../src/input.js');
    const fakeClassify = vi.fn().mockResolvedValue({
      decision: 'execute',
      intent: 'unknown_intent', // 上方 createTestRegistry 注册的 unknown plugin
      noteSubtype: 'note',
      linkedSourceId: 42,
      relatedTo: null,
    });

    // B2: 校验上浮到 handleInput —— linkedSourceId 必须 ∈ recentMessages 提到的
    // sourceId 集合，否则被清成 undefined。recentMessages 加一条 assistant turn
    // metadata.sourceId=42 让校验通过。
    const deps = makeDecisionDeps({
      classifyIntent: fakeClassify,
      conversation: {
        sessionKey: 'test:1',
        conversationId: 1,
        channelId: 'test',
        recentMessages: [
          {
            id: 99,
            role: 'assistant' as const,
            content: 'submitted',
            createdAt: new Date(),
            metadata: { sourceId: 42 },
          },
          { id: 100, role: 'user' as const, content: 'cur', createdAt: new Date() },
        ],
        messageWindowSize: 6,
        startedAt: new Date(),
      },
    });
    // 用 plugin spy 抓 context 参数
    const plugin = deps.pluginRegistry.findIntentDeclaration('unknown_intent')!.plugin;
    const executeSpy = vi.fn().mockResolvedValue({
      type: 'content',
      text: 'ok',
    });
    plugin.execute = executeSpy;

    await handleInput('today shipped X', deps);

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const ctx = executeSpy.mock.calls[0]?.[2];
    expect(ctx.linkedSourceId).toBe(42);
    expect(ctx.noteSubtype).toBe('note');
    expect(ctx.currentUserMessageId).toBe(100);
  });

  it('DI: classifyIntent 走 deps 注入版本（不调用 import 默认实现）', async () => {
    const { handleInput } = await import('../src/input.js');
    const { classifyIntent } = await import('../src/intent/classify.js');
    const fakeClassify = vi.fn().mockResolvedValue({
      decision: 'execute',
      intent: 'query',
      relatedTo: null,
    });
    const { queryKnowledge } = await import('../src/query/index.js');
    vi.mocked(queryKnowledge).mockResolvedValue({ answer: 'ok', confidence: 'high' });

    const deps = makeDecisionDeps({ classifyIntent: fakeClassify });
    await handleInput('What is X?', deps);

    expect(fakeClassify).toHaveBeenCalledTimes(1);
    // 默认 classifyIntent 不应被调用（DI 接管）
    expect(vi.mocked(classifyIntent)).not.toHaveBeenCalled();
  });
});

// ─── Path C — reconcileExpiredBufferedBySession (caller 入口前 await) ───
//
// A5 修复：原 handleInput 内 fire-and-forget IIFE 已废弃（与主路径 classify 的
// assistant turn 写入存在 ordering race）。reconcile 由 caller (apps/server
// main.ts / im-runtime dispatcher.ts) 在 appendUserTurn 之前同步 await
// reconcileExpiredBufferedBySession 触发。测试改为直接调 helper。
describe('reconcileExpiredBufferedBySession (Path C)', () => {
  let mockLlm: ReturnType<typeof createMockCallLlm>;
  let llmCallRepo: ReturnType<typeof createMockLlmCallRepo>;
  let pluginRegistry: PluginRegistry;
  let config: GoldpanConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    resetIdSequences();
    mockLlm = createMockCallLlm();
    llmCallRepo = createMockLlmCallRepo();
    pluginRegistry = createTestRegistry();
    config = createTestConfig();
  });

  it('finalize 该 sessionKey 的 expired buffered → loadContext 跳过 consumed', async () => {
    const { handleInput } = await import('../src/input.js');
    const { reconcileExpiredBufferedBySession } = await import(
      '../src/conversation/buffer-reconcile.js'
    );
    const { queryKnowledge } = await import('../src/query/index.js');
    vi.mocked(queryKnowledge).mockResolvedValue({ answer: 'ok', confidence: 'high' });

    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = repo.findOrCreate('test:c:1', 'test');
      const { id: bufId } = repo.appendMessage(convId, { role: 'user', content: 'old' });
      // 已 expired 的 buffer（超过 5s grace 之外）
      repo.markBufferedWait(bufId, Date.now() - 60000, { fallbackIntent: 'create_note' });

      const deps = {
        db: tdb.db,
        callLlm: mockLlm.fn,
        pluginRegistry,
        config,
        repos: {
          llmCall: llmCallRepo,
          submissionLog: undefined as any,
          knowledge: {} as any,
          category: {} as any,
          notes: {} as any,
          source: {} as any,
          conversation: repo as any,
        },
        logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
        handleInput,
      };

      await reconcileExpiredBufferedBySession('test:c:1', deps);

      // 验证：bufId 已 consumed（loadContext 跳过 consumed）
      const ctx = repo.loadContext('test:c:1', 6);
      expect(ctx?.recentMessages.find((m) => m.id === bufId)).toBeUndefined();
    } finally {
      tdb.cleanup();
    }
  });

  it('未 expired 的 buffer 不被 reconcile 触碰（仍待 Path A merge 处理）', async () => {
    const { handleInput } = await import('../src/input.js');
    const { reconcileExpiredBufferedBySession } = await import(
      '../src/conversation/buffer-reconcile.js'
    );
    const { queryKnowledge } = await import('../src/query/index.js');
    vi.mocked(queryKnowledge).mockResolvedValue({ answer: 'ok', confidence: 'high' });

    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = repo.findOrCreate('test:c:2', 'test');
      const { id: bufId } = repo.appendMessage(convId, { role: 'user', content: 'active' });
      // 仍在 grace 之内：expiresAt 在未来 30s
      repo.markBufferedWait(bufId, Date.now() + 30000, { fallbackIntent: 'create_note' });

      const deps = {
        db: tdb.db,
        callLlm: mockLlm.fn,
        pluginRegistry,
        config,
        repos: {
          llmCall: llmCallRepo,
          submissionLog: undefined as any,
          knowledge: {} as any,
          category: {} as any,
          notes: {} as any,
          source: {} as any,
          conversation: repo as any,
        },
        logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
        handleInput,
      };

      await reconcileExpiredBufferedBySession('test:c:2', deps);

      // bufId 仍是 buffered_wait（未 expired 的 reconcile 不动）
      const ctx = repo.loadContext('test:c:2', 6);
      expect(ctx?.recentMessages.find((m) => m.id === bufId)?.status).toBe('buffered_wait');
    } finally {
      tdb.cleanup();
    }
  });
});
