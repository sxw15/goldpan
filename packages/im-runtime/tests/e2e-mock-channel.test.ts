import { type HandleInputRepos, SqliteConversationRepository } from '@goldpan/core';
import { type ILogObj, Logger } from 'tslog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMRuntime, type IMRuntimeDeps } from '../src/index.js';
import { createMockChannel } from '../src/testing/index.js';
import { createTestDB, type TestDB } from './helpers/test-db.js';

describe('E2E: mock channel through IMRuntime', () => {
  let testDb: TestDB;
  let runtime: IMRuntime | null = null;

  beforeEach(() => {
    testDb = createTestDB();
  });
  afterEach(async () => {
    if (runtime) {
      await runtime.shutdown();
      runtime = null;
    }
    testDb.cleanup();
  });

  it('free text → injected handleInput → reply lands in mock.sent', async () => {
    const ch = createMockChannel({ channelId: 'mock' });
    const conversationRepo = new SqliteConversationRepository(testDb.db);
    const handleInput = vi.fn(async () => ({
      type: 'content' as const,
      text: 'hello back',
      format: 'text' as const,
    }));

    const deps: IMRuntimeDeps = {
      db: testDb.db,
      callLlm: (() => {}) as never,
      pluginRegistry: { getIntentDeclarations: () => [] } as never,
      config: { language: 'en' } as never,
      repos: {} as HandleInputRepos,
      conversationRepo,
      logger: new Logger<ILogObj>({ type: 'hidden' }),
    };
    runtime = new IMRuntime(deps, { handleInput });
    runtime.register(ch.adapter);

    await runtime.start();
    await ch.emit({ text: 'hi there', chatId: 'C', userId: 'U' });

    expect(handleInput).toHaveBeenCalledTimes(1);
    expect(ch.sent.map((p) => p.text)).toEqual(['hello back']);

    // Conversation persistence: user turn + assistant turn both committed.
    const stored = conversationRepo.loadContext('mock:mock-acct:C', 8);
    expect(stored?.recentMessages.map((m) => m.content)).toEqual(['hi there', 'hello back']);
  });

  it('clarify result rendered with assistantMessageId in render context', async () => {
    const ch = createMockChannel({ channelId: 'mock' });
    const conversationRepo = new SqliteConversationRepository(testDb.db);
    const observedRenderCtx: Array<{ assistantMessageId?: number; conversationId?: number }> = [];
    ch.adapter.renderResult = (r, ctx) => {
      observedRenderCtx.push({
        assistantMessageId: ctx.assistantMessageId,
        conversationId: ctx.conversationId,
      });
      return { text: r.type === 'clarify' ? `clarify:${r.options?.length ?? 0}` : 'other' };
    };

    runtime = new IMRuntime(
      {
        db: testDb.db,
        callLlm: (() => {}) as never,
        pluginRegistry: { getIntentDeclarations: () => [] } as never,
        config: { language: 'en' } as never,
        repos: {} as HandleInputRepos,
        conversationRepo,
        logger: new Logger<ILogObj>({ type: 'hidden' }),
      },
      {
        handleInput: async () => ({
          type: 'clarify',
          question: 'which?',
          options: ['x', 'y'],
        }),
      },
    );
    runtime.register(ch.adapter);
    await runtime.start();
    await ch.emit({ text: 'do it', chatId: 'C', userId: 'U' });

    expect(observedRenderCtx).toHaveLength(1);
    expect(observedRenderCtx[0].assistantMessageId).toBeGreaterThan(0);
    expect(observedRenderCtx[0].conversationId).toBeGreaterThan(0);
  });
});
