import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteLlmCallRepository } from '../../../src/db/repositories/llm-call.repository.js';
import { SqliteSourceRepository } from '../../../src/db/repositories/source.repository.js';
import { createTestDB, type TestDB } from '../../helpers/test-db.js';

describe('LlmCallRepository', () => {
  let t: TestDB;
  let repo: SqliteLlmCallRepository;
  let sourceId: number;

  beforeEach(() => {
    t = createTestDB();
    repo = new SqliteLlmCallRepository(t.db);
    const sourceRepo = new SqliteSourceRepository(t.db);
    const source = sourceRepo.create({
      kind: 'user',
      rawContent: 'test content for LLM call',
    });
    sourceId = source.id;
  });

  afterEach(() => {
    t.cleanup();
  });

  it('creates an LLM call record with all fields', () => {
    const call = repo.create({
      step: 'classifier',
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 150,
      outputTokens: 50,
      requestBody: '{"messages":[...]}',
      responseBody: '{"choices":[...]}',
      requestSchema: null,
      promptHash: 'abc12345',
      sourceId,
      outcome: 'success',
      failureKind: null,
      failureMessage: null,
      attemptNumber: 1,
    });

    expect(call.id).toBeTypeOf('number');
    expect(call.step).toBe('classifier');
    expect(call.provider).toBe('openai');
    expect(call.model).toBe('gpt-4o-mini');
    expect(call.inputTokens).toBe(150);
    expect(call.outputTokens).toBe(50);
    expect(call.requestBody).toBe('{"messages":[...]}');
    expect(call.responseBody).toBe('{"choices":[...]}');
    expect(call.promptHash).toBe('abc12345');
    expect(call.sourceId).toBe(sourceId);
    expect(call.timestamp).toBeTruthy();
  });

  it('creates an LLM call record with null optional fields', () => {
    const call = repo.create({
      step: 'extractor',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      inputTokens: null,
      outputTokens: null,
      requestBody: null,
      responseBody: null,
      requestSchema: null,
      promptHash: 'def67890',
      sourceId: null,
      outcome: 'failed',
      failureKind: 'schema_validation',
      failureMessage: 'bad output',
      attemptNumber: 2,
    });

    expect(call.id).toBeTypeOf('number');
    expect(call.step).toBe('extractor');
    expect(call.inputTokens).toBeNull();
    expect(call.outputTokens).toBeNull();
    expect(call.requestBody).toBeNull();
    expect(call.responseBody).toBeNull();
    expect(call.sourceId).toBeNull();
  });

  it('rejects invalid step values', () => {
    expect(() =>
      repo.create({
        step: 'invalid_step' as any,
        provider: 'openai',
        model: 'gpt-4o-mini',
        inputTokens: 100,
        outputTokens: 50,
        requestBody: null,
        responseBody: null,
        requestSchema: null,
        promptHash: 'abc12345',
        sourceId: null,
        outcome: 'success',
        failureKind: null,
        failureMessage: null,
        attemptNumber: 1,
      }),
    ).toThrow();
  });

  it('creates records for all valid step types', () => {
    const steps = [
      'classifier',
      'extractor',
      'matcher',
      'comparator',
      'verifier',
      'intent_classifier',
      'query_understand',
      'query',
    ] as const;
    for (const step of steps) {
      const call = repo.create({
        step,
        provider: 'openai',
        model: 'gpt-4o-mini',
        inputTokens: 100,
        outputTokens: 50,
        requestBody: null,
        responseBody: null,
        requestSchema: null,
        promptHash: `hash-${step}`,
        sourceId: null,
        outcome: 'success',
        failureKind: null,
        failureMessage: null,
        attemptNumber: 1,
      });
      expect(call.step).toBe(step);
    }
  });

  it('stores and retrieves intent_classifier step', () => {
    const call = repo.create({
      step: 'intent_classifier',
      provider: 'openai',
      model: 'gpt-4o-mini',
      sourceId: null,
      promptHash: 'intent01',
      inputTokens: 100,
      outputTokens: 50,
      outcome: 'success',
      failureKind: null,
      failureMessage: null,
      attemptNumber: 1,
      requestBody: null,
      responseBody: null,
      requestSchema: null,
    });
    const fetched = repo.getById(call.id);
    expect(fetched).toBeDefined();
    expect(fetched!.step).toBe('intent_classifier');
  });

  it('stores and retrieves query_understand step', () => {
    const call = repo.create({
      step: 'query_understand',
      provider: 'openai',
      model: 'gpt-4o-mini',
      sourceId: null,
      promptHash: 'query_u1',
      inputTokens: 100,
      outputTokens: 50,
      outcome: 'success',
      failureKind: null,
      failureMessage: null,
      attemptNumber: 1,
      requestBody: null,
      responseBody: null,
      requestSchema: null,
    });
    const fetched = repo.getById(call.id);
    expect(fetched).toBeDefined();
    expect(fetched!.step).toBe('query_understand');
  });

  it('stores and retrieves query step', () => {
    const call = repo.create({
      step: 'query',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      sourceId: null,
      promptHash: 'query01',
      inputTokens: 200,
      outputTokens: 100,
      outcome: 'success',
      failureKind: null,
      failureMessage: null,
      attemptNumber: 1,
      requestBody: null,
      responseBody: null,
      requestSchema: null,
    });
    const fetched = repo.getById(call.id);
    expect(fetched).toBeDefined();
    expect(fetched!.step).toBe('query');
  });
});
