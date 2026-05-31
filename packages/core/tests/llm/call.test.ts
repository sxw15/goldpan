import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { z } from 'zod';
import { createTestDB, type TestDB } from '../helpers/test-db.js';

vi.mock('ai', () => ({
  generateText: vi.fn(),
  Output: {
    object: vi.fn(({ schema }: { schema: z.ZodSchema }) => ({
      type: 'object',
      schema,
    })),
  },
  NoObjectGeneratedError: {
    isInstance: (error: unknown) =>
      error instanceof Error && (error as any).name === 'AI_NoObjectGeneratedError',
  },
}));

import { generateText } from 'ai';
import { SqliteLlmCallRepository } from '../../src/db/repositories/llm-call.repository.js';
import { llmCalls, sources } from '../../src/db/schema.js';

const mockGenerateText = generateText as Mock;

describe('callLlm', () => {
  let t: TestDB;
  let llmCallRepo: SqliteLlmCallRepository;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    t = createTestDB();
    llmCallRepo = new SqliteLlmCallRepository(t.db);
    mockGenerateText.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    t.cleanup();
  });

  async function importCallLlm() {
    const mod = await import('../../src/llm/call.js');
    return mod.callLlm;
  }

  const testSchema = z.object({
    category: z.string(),
    keywords: z.array(z.string()),
  });

  function makeMockModel() {
    return {
      modelId: 'gpt-4o-mini',
      provider: 'openai.chat',
      specificationVersion: 'v1',
    };
  }

  it('returns parsed output on success and records to llm_calls', async () => {
    const callLlm = await importCallLlm();

    mockGenerateText.mockResolvedValue({
      output: { category: 'Tech/AI', keywords: ['LLM', 'AI'] },
      text: '{"category":"Tech/AI","keywords":["LLM","AI"]}',
      usage: { promptTokens: 100, completionTokens: 50 },
      response: {
        messages: [
          { role: 'assistant', content: '{"category":"Tech/AI","keywords":["LLM","AI"]}' },
        ],
      },
    });

    const result = await callLlm({
      model: makeMockModel() as any,
      step: 'classifier',
      schema: testSchema,
      system: 'You are a classifier.',
      prompt: 'Classify this article.',
      promptHash: 'abc12345',
      sourceId: null,
      llmCallRepo,
      logPayloads: false,
      timeout: 30,
    });

    expect(result).toEqual({ category: 'Tech/AI', keywords: ['LLM', 'AI'] });

    const calls = t.db.select().from(llmCalls).all();
    expect(calls).toHaveLength(1);
    expect(calls[0].step).toBe('classifier');
    expect(calls[0].inputTokens).toBe(100);
    expect(calls[0].outputTokens).toBe(50);
    expect(calls[0].promptHash).toBe('abc12345');
    expect(calls[0].requestBody).toBeNull();
    expect(calls[0].responseBody).toBeNull();
    expect(calls[0].outcome).toBe('success');
    expect(calls[0].failureKind).toBeNull();
    expect(calls[0].attemptNumber).toBe(1);
  });

  it('records request/response body when logPayloads is true', async () => {
    const callLlm = await importCallLlm();

    mockGenerateText.mockResolvedValue({
      output: { category: 'Tech', keywords: ['test'] },
      text: '{"category":"Tech","keywords":["test"]}',
      usage: { promptTokens: 50, completionTokens: 20 },
      response: {
        messages: [{ role: 'assistant', content: 'response' }],
      },
    });

    await callLlm({
      model: makeMockModel() as any,
      step: 'extractor',
      schema: testSchema,
      system: 'System prompt',
      prompt: 'Extract knowledge.',
      promptHash: 'def67890',
      sourceId: null,
      llmCallRepo,
      logPayloads: true,
      timeout: 30,
    });

    const calls = t.db.select().from(llmCalls).all();
    expect(calls).toHaveLength(1);
    expect(calls[0].requestBody).toBeTruthy();
    expect(calls[0].responseBody).toBeTruthy();
  });

  it('throws PipelineError when output is null (schema validation failure)', async () => {
    const callLlm = await importCallLlm();

    mockGenerateText.mockResolvedValue({
      output: null,
      text: 'invalid output that failed schema validation',
      usage: { promptTokens: 100, completionTokens: 50 },
      response: {
        messages: [{ role: 'assistant', content: 'bad output' }],
      },
    });

    await expect(
      callLlm({
        model: makeMockModel() as any,
        step: 'classifier',
        schema: testSchema,
        system: 'System prompt',
        prompt: 'Classify this.',
        promptHash: 'abc12345',
        sourceId: null,
        llmCallRepo,
        logPayloads: false,
        timeout: 30,
      }),
    ).rejects.toThrow(/schema validation/i);

    // With 2 schema retries, generateText is called three times; mock always returns null output,
    // so all three rows are failed attempts, then the pipeline throws.
    const calls = t.db.select().from(llmCalls).all();
    expect(calls).toHaveLength(3);
    expect(calls[0].outcome).toBe('failed');
    expect(calls[0].failureKind).toBe('schema_validation');
    expect(calls[0].attemptNumber).toBe(1);
    expect(calls[1].outcome).toBe('failed');
    expect(calls[1].attemptNumber).toBe(2);
    expect(calls[2].outcome).toBe('failed');
    expect(calls[2].attemptNumber).toBe(3);
  });

  it('retries on 429 rate limit with exponential backoff', async () => {
    const callLlm = await importCallLlm();

    const rateLimitError = new Error('Rate limit exceeded');
    (rateLimitError as any).status = 429;
    (rateLimitError as any).statusCode = 429;

    mockGenerateText
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValue({
        output: { category: 'Tech', keywords: ['AI'] },
        text: '{"category":"Tech","keywords":["AI"]}',
        usage: { promptTokens: 100, completionTokens: 50 },
        response: {
          messages: [{ role: 'assistant', content: 'ok' }],
        },
      });

    const promise = callLlm({
      model: makeMockModel() as any,
      step: 'classifier',
      schema: testSchema,
      system: 'System',
      prompt: 'Test',
      promptHash: 'hash',
      sourceId: null,
      llmCallRepo,
      logPayloads: false,
      timeout: 30,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;

    expect(result).toEqual({ category: 'Tech', keywords: ['AI'] });
    expect(mockGenerateText).toHaveBeenCalledTimes(3);

    // Each attempt is recorded: 2 rate-limit failures + 1 success
    const calls = t.db.select().from(llmCalls).all();
    expect(calls).toHaveLength(3);
    expect(calls[0].outcome).toBe('failed');
    expect(calls[0].failureKind).toBe('rate_limit');
    expect(calls[0].attemptNumber).toBe(1);
    expect(calls[1].outcome).toBe('failed');
    expect(calls[1].failureKind).toBe('rate_limit');
    expect(calls[1].attemptNumber).toBe(2);
    expect(calls[2].outcome).toBe('success');
    expect(calls[2].attemptNumber).toBe(3);
  });

  it('throws after max 429 retries exhausted', async () => {
    const callLlm = await importCallLlm();

    const rateLimitError = new Error('Rate limit exceeded');
    (rateLimitError as any).status = 429;
    (rateLimitError as any).statusCode = 429;

    mockGenerateText
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(rateLimitError);

    const promise = callLlm({
      model: makeMockModel() as any,
      step: 'classifier',
      schema: testSchema,
      system: 'System',
      prompt: 'Test',
      promptHash: 'hash',
      sourceId: null,
      llmCallRepo,
      logPayloads: false,
      timeout: 30,
    });
    // Prevent unhandled rejection warning from fake timers
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);

    await expect(promise).rejects.toThrow(/rate limit/i);
  });

  it('handles content policy errors with distinct error kind', async () => {
    const callLlm = await importCallLlm();

    const contentPolicyError = new Error('Content policy violation');
    (contentPolicyError as any).status = 400;
    (contentPolicyError as any).data = { error: { type: 'content_policy_violation' } };

    mockGenerateText.mockRejectedValue(contentPolicyError);

    try {
      await callLlm({
        model: makeMockModel() as any,
        step: 'classifier',
        schema: testSchema,
        system: 'System',
        prompt: 'Harmful content',
        promptHash: 'hash',
        sourceId: null,
        llmCallRepo,
        logPayloads: false,
        timeout: 30,
      });
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.message).toMatch(/content policy/i);
      expect(error.kind).toBe('content_policy');
    }

    const calls = t.db.select().from(llmCalls).all();
    expect(calls).toHaveLength(1);
    expect(calls[0].outcome).toBe('failed');
    expect(calls[0].failureKind).toBe('content_policy');
  });

  it('passes maxRetries and timeout to generateText', async () => {
    const callLlm = await importCallLlm();

    mockGenerateText.mockResolvedValue({
      output: { category: 'Tech', keywords: ['AI'] },
      text: 'ok',
      usage: { promptTokens: 10, completionTokens: 5 },
      response: { messages: [] },
    });

    await callLlm({
      model: makeMockModel() as any,
      step: 'classifier',
      schema: testSchema,
      system: 'System',
      prompt: 'Test',
      promptHash: 'hash',
      sourceId: null,
      llmCallRepo,
      logPayloads: false,
      timeout: 60,
    });

    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.maxRetries).toBe(0);
    expect(callArgs.abortSignal).toBeDefined();
  });

  it('extracts provider and model from model object', async () => {
    const callLlm = await importCallLlm();

    // Insert a source so FK constraint is satisfied
    t.db
      .insert(sources)
      .values({
        kind: 'external',
        normalizedUrl: 'https://test.example.com/article',
        originalUrl: 'https://test.example.com/article',
        status: 'processing',
      })
      .run();
    const insertedSource = t.db.select().from(sources).all();
    const sourceId = insertedSource[0].id;

    mockGenerateText.mockResolvedValue({
      output: { category: 'Tech', keywords: ['AI'] },
      text: 'ok',
      usage: { promptTokens: 10, completionTokens: 5 },
      response: { messages: [] },
    });

    await callLlm({
      model: makeMockModel() as any,
      step: 'classifier',
      schema: testSchema,
      system: 'System',
      prompt: 'Test',
      promptHash: 'hash',
      sourceId,
      llmCallRepo,
      logPayloads: false,
      timeout: 30,
    });

    const calls = t.db.select().from(llmCalls).all();
    expect(calls[0].provider).toContain('openai');
    expect(calls[0].model).toBe('gpt-4o-mini');
    expect(calls[0].sourceId).toBe(sourceId);
  });

  it('records llm_calls entry for exhausted 429 retries', async () => {
    const callLlm = await importCallLlm();

    const rateLimitError = new Error('Rate limit exceeded');
    (rateLimitError as any).status = 429;
    (rateLimitError as any).statusCode = 429;

    mockGenerateText.mockRejectedValue(rateLimitError);

    const promise = callLlm({
      model: makeMockModel() as any,
      step: 'extractor',
      schema: testSchema,
      system: 'System',
      prompt: 'Test',
      promptHash: 'hash-retry',
      sourceId: null,
      llmCallRepo,
      logPayloads: false,
      timeout: 30,
    });
    // Prevent unhandled rejection warning from fake timers
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);

    await expect(promise).rejects.toThrow(/rate limit/i);

    // 3 per-retry records (attempts 1–3) + 1 final-attempt record after budget exhausted (attempt 4)
    const calls = t.db.select().from(llmCalls).all();
    expect(calls).toHaveLength(4);
    expect(calls[0].step).toBe('extractor');
    expect(calls[0].outcome).toBe('failed');
    expect(calls[0].failureKind).toBe('rate_limit');
    expect(calls[0].attemptNumber).toBe(1);
    expect(calls[1].attemptNumber).toBe(2);
    expect(calls[2].attemptNumber).toBe(3);
    expect(calls[3].attemptNumber).toBe(4);
    expect(calls[3].outcome).toBe('failed');
    expect(calls[3].failureKind).toBe('rate_limit');
  });

  it('handles timeout with correct error kind and records call', async () => {
    const callLlm = await importCallLlm();

    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';

    mockGenerateText.mockRejectedValue(abortError);

    try {
      await callLlm({
        model: makeMockModel() as any,
        step: 'matcher',
        schema: testSchema,
        system: 'System',
        prompt: 'Test',
        promptHash: 'hash-timeout',
        sourceId: null,
        llmCallRepo,
        logPayloads: false,
        timeout: 1,
      });
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.kind).toBe('timeout');
      expect(error.step).toBe('matcher');
    }

    const calls = t.db.select().from(llmCalls).all();
    expect(calls).toHaveLength(1);
    expect(calls[0].step).toBe('matcher');
    expect(calls[0].outcome).toBe('failed');
    expect(calls[0].failureKind).toBe('unknown');
  });

  it('records llm_calls entry for generic failures', async () => {
    const callLlm = await importCallLlm();

    mockGenerateText.mockRejectedValue(new Error('Network error'));

    await expect(
      callLlm({
        model: makeMockModel() as any,
        step: 'comparator',
        schema: testSchema,
        system: 'System',
        prompt: 'Test',
        promptHash: 'hash-generic',
        sourceId: null,
        llmCallRepo,
        logPayloads: false,
        timeout: 30,
      }),
    ).rejects.toThrow(/network error/i);

    const calls = t.db.select().from(llmCalls).all();
    expect(calls).toHaveLength(1);
    expect(calls[0].step).toBe('comparator');
    expect(calls[0].outcome).toBe('failed');
    expect(calls[0].failureKind).toBe('unknown');
  });

  it('classifies NoObjectGeneratedError as schema_validation', async () => {
    const callLlm = await importCallLlm();

    const schemaError = new Error('No object generated');
    (schemaError as any).name = 'AI_NoObjectGeneratedError';
    (schemaError as any).text = '{"partial": "bad output"}';
    (schemaError as any).usage = { promptTokens: 80, completionTokens: 30, totalTokens: 110 };

    mockGenerateText
      .mockRejectedValueOnce(schemaError)
      .mockRejectedValueOnce(schemaError)
      .mockRejectedValueOnce(schemaError);

    try {
      await callLlm({
        model: makeMockModel() as any,
        step: 'classifier',
        schema: testSchema,
        system: 'System',
        prompt: 'Test',
        promptHash: 'hash-schema',
        sourceId: null,
        llmCallRepo,
        logPayloads: false,
        timeout: 30,
      });
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.message).toMatch(/schema validation/i);
      expect(error.kind).toBe('schema_validation');
    }

    const calls = t.db.select().from(llmCalls).all();
    expect(calls).toHaveLength(3);
    expect(calls[0].step).toBe('classifier');
    expect(calls[0].outcome).toBe('failed');
    expect(calls[0].failureKind).toBe('schema_validation');
    expect(calls[0].attemptNumber).toBe(1);
    expect(calls[0].inputTokens).toBe(80);
    expect(calls[0].outputTokens).toBe(30);
    expect(calls[1].outcome).toBe('failed');
    expect(calls[1].attemptNumber).toBe(2);
    expect(calls[2].outcome).toBe('failed');
    expect(calls[2].attemptNumber).toBe(3);
  });

  it('captures response body from NoObjectGeneratedError when logPayloads is true', async () => {
    const callLlm = await importCallLlm();

    const schemaError = new Error('No object generated: response did not match schema');
    (schemaError as any).name = 'AI_NoObjectGeneratedError';
    (schemaError as any).text = '{"wrong_field": "value"}';
    (schemaError as any).usage = { promptTokens: 60, completionTokens: 25, totalTokens: 85 };

    mockGenerateText
      .mockRejectedValueOnce(schemaError)
      .mockRejectedValueOnce(schemaError)
      .mockRejectedValueOnce(schemaError);

    try {
      await callLlm({
        model: makeMockModel() as any,
        step: 'classifier',
        schema: testSchema,
        system: 'System prompt',
        prompt: 'Test prompt',
        promptHash: 'hash-schema-body',
        sourceId: null,
        llmCallRepo,
        logPayloads: true,
        timeout: 30,
      });
      expect.fail('Should have thrown');
    } catch {
      // expected
    }

    const calls = t.db.select().from(llmCalls).all();
    expect(calls).toHaveLength(3);
    expect(calls[0].inputTokens).toBe(60);
    expect(calls[0].outputTokens).toBe(25);
    expect(calls[0].responseBody).toBe('{"wrong_field": "value"}');
    expect(calls[0].requestBody).toBeTruthy();
  });
});
