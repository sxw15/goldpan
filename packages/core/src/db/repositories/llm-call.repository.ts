import { asc, eq } from 'drizzle-orm';
import type { DrizzleDB } from '../connection';
import { llmCalls } from '../schema';
import { utcNowMs } from '../timestamp';
import type { CreateLlmCallInput, LlmCall, LlmCallMeta, LlmCallRepository } from './types';

export class SqliteLlmCallRepository implements LlmCallRepository {
  constructor(private db: DrizzleDB) {}

  create(input: CreateLlmCallInput): LlmCall {
    const rows = this.db
      .insert(llmCalls)
      .values({
        step: input.step,
        provider: input.provider,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        requestBody: input.requestBody,
        responseBody: input.responseBody,
        requestSchema: input.requestSchema,
        promptHash: input.promptHash,
        sourceId: input.sourceId,
        outcome: input.outcome,
        failureKind: input.failureKind,
        failureMessage: input.failureMessage,
        attemptNumber: input.attemptNumber,
        timestamp: utcNowMs(),
      })
      .returning()
      .all();
    return rows[0];
  }

  getById(id: number): LlmCall | undefined {
    return this.db.select().from(llmCalls).where(eq(llmCalls.id, id)).get();
  }

  getMetadataBySourceId(sourceId: number): LlmCallMeta[] {
    return this.db
      .select({
        id: llmCalls.id,
        step: llmCalls.step,
        provider: llmCalls.provider,
        model: llmCalls.model,
        inputTokens: llmCalls.inputTokens,
        outputTokens: llmCalls.outputTokens,
        promptHash: llmCalls.promptHash,
        sourceId: llmCalls.sourceId,
        outcome: llmCalls.outcome,
        failureKind: llmCalls.failureKind,
        failureMessage: llmCalls.failureMessage,
        attemptNumber: llmCalls.attemptNumber,
        timestamp: llmCalls.timestamp,
      })
      .from(llmCalls)
      .where(eq(llmCalls.sourceId, sourceId))
      .orderBy(asc(llmCalls.timestamp))
      .all();
  }
}
