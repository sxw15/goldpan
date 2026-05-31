import type { ILogObj, Logger } from 'tslog';
import { describe, expect, it, vi } from 'vitest';
import { finalizeBuffer } from '../../src/conversation/buffer-finalize.js';
import { SqliteConversationRepository } from '../../src/db/repositories/conversation.repository.js';
import type { HandleInputRepos } from '../../src/plugins/types.js';
import { createTestDB } from '../helpers/test-db.js';

// Inline helper（P0/P1 风格）：finalizeBuffer 只访问 deps.repos.conversation，
// 其它字段塞 {} as never 即可满足 HandleInputRepos shape。
function makeFakeRepos(_db: unknown, conversation: SqliteConversationRepository): HandleInputRepos {
  return {
    llmCall: {} as never,
    submissionLog: {} as never,
    knowledge: {} as never,
    category: {} as never,
    notes: {} as never,
    source: {} as never,
    conversation,
  };
}

function silentLogger(): Logger<ILogObj> {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger<ILogObj>;
}

function fakeConfig() {
  // finalizeBuffer 只读 config.im.conversationWindowSize；其它字段在执行路径里
  // 没人 touch，传成对象字面量即可。
  return {
    im: { conversationWindowSize: 6 },
  } as never;
}

describe('finalizeBuffer', () => {
  it('CAS 成功 → 标 consumed + 调 handleInput(forcedIntent=fallbackIntent)', async () => {
    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = repo.findOrCreate('test:fb:1', 'test');
      const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: '想法 X' });
      repo.markBufferedWait(msgId, Date.now() + 30000, {
        decision: 'wait',
        fallbackIntent: 'create_note',
        intent: 'create_note',
        waitReason: 'incomplete_command',
        linkedSourceId: null,
      });

      const fakeHandleInput = vi.fn().mockResolvedValue({
        type: 'note',
        detail: { id: 99, content: '想法 X', subtype: 'note' },
      });

      const result = await finalizeBuffer(msgId, {
        db: tdb.db,
        repos: makeFakeRepos(tdb.db, repo),
        logger: silentLogger(),
        handleInput: fakeHandleInput,
        callLlm: {} as never,
        pluginRegistry: {} as never,
        config: fakeConfig(),
      });

      expect(result).not.toBeNull();
      expect(result?.executed).toBe(true);
      expect(result?.result?.type).toBe('note');

      // 验证 handleInput 被 forced 调用
      expect(fakeHandleInput).toHaveBeenCalledTimes(1);
      const callArg = fakeHandleInput.mock.calls[0]?.[1];
      expect(callArg.forcedIntent).toBe('create_note');
      expect(callArg.currentUserMessageId).toBe(msgId);

      // 验证 status 已是 consumed
      const ctx = repo.loadContext('test:fb:1', 6);
      // 该 message 已 consumed → 不在 recentMessages 里
      expect(ctx?.recentMessages.find((m) => m.id === msgId)).toBeUndefined();
    } finally {
      tdb.cleanup();
    }
  });

  it('CAS 失败（已被并发 finalize）→ 返 null，不再调 handleInput', async () => {
    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = repo.findOrCreate('test:fb:2', 'test');
      const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'q' });
      repo.markBufferedWait(msgId, Date.now() + 30000, { fallbackIntent: 'query' });
      repo.consumeBuffered(msgId); // 模拟"已被并发 finalize"

      const fakeHandleInput = vi.fn();
      const result = await finalizeBuffer(msgId, {
        db: tdb.db,
        repos: makeFakeRepos(tdb.db, repo),
        logger: silentLogger(),
        handleInput: fakeHandleInput,
        callLlm: {} as never,
        pluginRegistry: {} as never,
        config: fakeConfig(),
      });

      expect(result).toBeNull();
      expect(fakeHandleInput).not.toHaveBeenCalled();
    } finally {
      tdb.cleanup();
    }
  });

  it('linkedSourceId / noteSubtype 从 classifierDecision 注入 IntentExecutionContext', async () => {
    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = repo.findOrCreate('test:fb:3', 'test');
      const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'about it' });
      repo.markBufferedWait(msgId, Date.now() + 30000, {
        fallbackIntent: 'create_note',
        linkedSourceId: 42,
        noteSubtype: 'memo',
      });

      const fakeHandleInput = vi.fn().mockResolvedValue({ type: 'note', detail: {} });
      await finalizeBuffer(msgId, {
        db: tdb.db,
        repos: makeFakeRepos(tdb.db, repo),
        logger: silentLogger(),
        handleInput: fakeHandleInput,
        callLlm: {} as never,
        pluginRegistry: {} as never,
        config: fakeConfig(),
      });

      const callDeps = fakeHandleInput.mock.calls[0]?.[1];
      expect(callDeps.linkedSourceId).toBe(42);
      expect(callDeps.noteSubtype).toBe('memo');
    } finally {
      tdb.cleanup();
    }
  });

  it('handleInput 抛错 → 已 consumed 不回滚，错误记日志', async () => {
    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = repo.findOrCreate('test:fb:err', 'test');
      const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'q' });
      repo.markBufferedWait(msgId, Date.now() + 30000, { fallbackIntent: 'query' });

      const logger = silentLogger();
      const failingHandleInput = vi.fn().mockRejectedValue(new Error('boom'));

      const result = await finalizeBuffer(msgId, {
        db: tdb.db,
        repos: makeFakeRepos(tdb.db, repo),
        logger,
        handleInput: failingHandleInput,
        callLlm: {} as never,
        pluginRegistry: {} as never,
        config: fakeConfig(),
      });

      // status 已 consumed 即可（finalize 失败不回滚，避免悬空再次卡 buffer）
      expect(result?.executed).toBe(false);
      expect(logger.error).toHaveBeenCalled();
    } finally {
      tdb.cleanup();
    }
  });

  it('messageId 不存在 → 返 null，不抛', async () => {
    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const fakeHandleInput = vi.fn();
      const result = await finalizeBuffer(999999, {
        db: tdb.db,
        repos: makeFakeRepos(tdb.db, repo),
        logger: silentLogger(),
        handleInput: fakeHandleInput,
        callLlm: {} as never,
        pluginRegistry: {} as never,
        config: fakeConfig(),
      });
      expect(result).toBeNull();
      expect(fakeHandleInput).not.toHaveBeenCalled();
    } finally {
      tdb.cleanup();
    }
  });
});
