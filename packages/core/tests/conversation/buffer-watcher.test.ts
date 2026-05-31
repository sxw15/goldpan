import type { ILogObj, Logger } from 'tslog';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBufferWatcher } from '../../src/conversation/buffer-watcher.js';
import { SqliteConversationRepository } from '../../src/db/repositories/conversation.repository.js';
import { createTestDB } from '../helpers/test-db.js';

function silentLogger(): Logger<ILogObj> {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger<ILogObj>;
}

describe('startBufferWatcher', () => {
  let stopWatcher: (() => void) | null = null;

  afterEach(() => {
    if (stopWatcher) {
      stopWatcher();
      stopWatcher = null;
    }
    vi.useRealTimers();
  });

  it('每个 tick 扫 expired buffer 调 finalize', async () => {
    vi.useFakeTimers();
    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = repo.findOrCreate('test:e:1', 'test');
      const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'q' });
      repo.markBufferedWait(msgId, Date.now() - 60000, { fallbackIntent: 'create_note' });

      const fakeFinalize = vi.fn().mockResolvedValue({ executed: true });
      stopWatcher = startBufferWatcher({
        db: tdb.db,
        repo,
        intervalMs: 1000,
        graceMs: 30000,
        batchSize: 10,
        logger: silentLogger(),
        finalize: fakeFinalize,
      });

      // 推进 1 个 tick
      await vi.advanceTimersByTimeAsync(1100);
      expect(fakeFinalize).toHaveBeenCalledWith(msgId);
    } finally {
      tdb.cleanup();
    }
  });

  it('多次 tick 不重复处理已 consumed 的（CAS 幂等）', async () => {
    vi.useFakeTimers();
    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = repo.findOrCreate('test:e:2', 'test');
      const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'q' });
      repo.markBufferedWait(msgId, Date.now() - 60000, {});

      let finalizeCallCount = 0;
      const fakeFinalize = vi.fn().mockImplementation(async (id: number) => {
        finalizeCallCount++;
        if (finalizeCallCount === 1) {
          // 模拟 finalize 把 message 标 consumed
          repo.consumeBuffered(id);
        }
        return { executed: true };
      });

      stopWatcher = startBufferWatcher({
        db: tdb.db,
        repo,
        intervalMs: 1000,
        graceMs: 30000,
        batchSize: 10,
        logger: silentLogger(),
        finalize: fakeFinalize,
      });

      await vi.advanceTimersByTimeAsync(3100); // 3 个 tick
      // 第一次 tick 把 message 处理掉；后续 tick findExpired 返空
      expect(fakeFinalize).toHaveBeenCalledTimes(1);
    } finally {
      tdb.cleanup();
    }
  });

  it('finalize 抛错不阻止后续 tick', async () => {
    vi.useFakeTimers();
    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = repo.findOrCreate('test:e:3', 'test');
      const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'q' });
      repo.markBufferedWait(msgId, Date.now() - 60000, {});

      const fakeFinalize = vi.fn().mockRejectedValue(new Error('boom'));
      const logger = silentLogger();
      stopWatcher = startBufferWatcher({
        db: tdb.db,
        repo,
        intervalMs: 1000,
        graceMs: 30000,
        batchSize: 10,
        logger,
        finalize: fakeFinalize,
      });

      await vi.advanceTimersByTimeAsync(2100);
      expect(logger.error).toHaveBeenCalled();
      // 但 watcher 仍然继续 —— 同 message 两次（CAS 内部已处理，这里 fake 不 consume）
      expect(fakeFinalize).toHaveBeenCalledTimes(2);
    } finally {
      tdb.cleanup();
    }
  });

  it('stop() 返回 cleanup 函数，立即停止', async () => {
    vi.useFakeTimers();
    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const fakeFinalize = vi.fn();
      const stop = startBufferWatcher({
        db: tdb.db,
        repo,
        intervalMs: 100,
        graceMs: 30000,
        batchSize: 10,
        logger: silentLogger(),
        finalize: fakeFinalize,
      });
      stop();
      stopWatcher = null;
      await vi.advanceTimersByTimeAsync(500);
      expect(fakeFinalize).not.toHaveBeenCalled();
    } finally {
      tdb.cleanup();
    }
  });

  it('GOLDPAN_DISABLE_BUFFER_WATCHER=true → 不启动', () => {
    const tdb = createTestDB();
    const originalEnv = process.env.GOLDPAN_DISABLE_BUFFER_WATCHER;
    try {
      process.env.GOLDPAN_DISABLE_BUFFER_WATCHER = 'true';
      const fakeFinalize = vi.fn();
      const stop = startBufferWatcher({
        db: tdb.db,
        repo: new SqliteConversationRepository(tdb.db),
        intervalMs: 1000,
        graceMs: 30000,
        batchSize: 10,
        logger: silentLogger(),
        finalize: fakeFinalize,
      });
      stop(); // 应该是 noop
      expect(fakeFinalize).not.toHaveBeenCalled();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.GOLDPAN_DISABLE_BUFFER_WATCHER;
      } else {
        process.env.GOLDPAN_DISABLE_BUFFER_WATCHER = originalEnv;
      }
      tdb.cleanup();
    }
  });
});
