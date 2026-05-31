import { SqliteError } from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationNotFoundError,
  SqliteConversationRepository,
} from '../../../src/db/repositories/conversation.repository.js';
import { conversationMessages, conversations } from '../../../src/db/schema.js';
import { createTestDB, type TestDB } from '../../helpers/test-db.js';

describe('SqliteConversationRepository', () => {
  let testDb: TestDB;
  let repo: SqliteConversationRepository;

  beforeEach(() => {
    testDb = createTestDB();
    repo = new SqliteConversationRepository(testDb.db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testDb.cleanup();
  });

  describe('findActiveBySessionKey', () => {
    it('returns active conversation id for exact sessionKey', () => {
      const { id: defaultId } = repo.findOrCreate('web:default', 'web');
      repo.findOrCreate('web:other', 'web');
      expect(repo.findActiveBySessionKey('web:default')).toBe(defaultId);
    });

    it('returns null when the session has no active conversation', () => {
      repo.findOrCreate('web:default', 'web');
      repo.archive('web:default', 'user_reset');
      expect(repo.findActiveBySessionKey('web:default')).toBeNull();
    });
  });

  describe('listBySessionKey', () => {
    it('lists only conversations for the exact sessionKey', () => {
      const defaultId = repo.findOrCreate('web:default', 'web').id;
      repo.appendMessage(defaultId, { role: 'user', content: 'default session' });
      repo.archive('web:default', 'user_reset');

      const otherId = repo.findOrCreate('web:other', 'web').id;
      repo.appendMessage(otherId, { role: 'user', content: 'other session' });
      repo.archive('web:other', 'user_reset');

      const res = repo.listBySessionKey({ sessionKey: 'web:default', limit: 10, offset: 0 });
      expect(res.items.map((x) => x.id)).toEqual([defaultId]);
      expect(res.total).toBe(1);
    });

    it('orders by updated_at DESC', () => {
      const a = repo.findOrCreate('web:default', 'web').id;
      repo.archive('web:default', 'user_reset');
      const b = repo.findOrCreate('web:default', 'web').id;
      repo.archive('web:default', 'user_reset');
      // Force distinct updated_at so ordering isn't ambiguous under sub-second insertion.
      // updated_at 是 INTEGER epoch ms 列 — 用数字写入。
      testDb.db
        .update(conversations)
        .set({ updatedAt: Date.UTC(2026, 0, 1, 0, 0, 0, 0) })
        .where(eq(conversations.id, b))
        .run();
      testDb.db
        .update(conversations)
        .set({ updatedAt: Date.UTC(2026, 5, 1, 0, 0, 0, 0) })
        .where(eq(conversations.id, a))
        .run();
      const res = repo.listBySessionKey({ sessionKey: 'web:default', limit: 10, offset: 0 });
      expect(res.items.map((x) => x.id)).toEqual([a, b]);
      expect(res.total).toBe(2);
    });

    it('uses id DESC as deterministic tie-breaker for same updated_at values', () => {
      const a = repo.findOrCreate('web:default', 'web').id;
      repo.archive('web:default', 'user_reset');
      const b = repo.findOrCreate('web:default', 'web').id;
      repo.archive('web:default', 'user_reset');

      const sameTime = Date.UTC(2026, 3, 25, 0, 0, 0, 0);
      testDb.db.update(conversations).set({ updatedAt: sameTime }).run();

      const res = repo.listBySessionKey({ sessionKey: 'web:default', limit: 10, offset: 0 });
      expect(res.items.map((x) => x.id)).toEqual([b, a]);
    });

    it('excludes active by default', () => {
      const active = repo.findOrCreate('web:default', 'web').id;
      const res = repo.listBySessionKey({ sessionKey: 'web:default', limit: 10, offset: 0 });
      expect(res.items.map((x) => x.id)).not.toContain(active);
      expect(res.total).toBe(0);
    });

    it('includes active when includeActive=true', () => {
      const a = repo.findOrCreate('web:default', 'web').id;
      const res = repo.listBySessionKey({
        sessionKey: 'web:default',
        limit: 10,
        offset: 0,
        includeActive: true,
      });
      expect(res.items.map((x) => x.id)).toEqual([a]);
    });

    it('derives title from first user message trunc 50 with ellipsis', () => {
      const { id } = repo.findOrCreate('web:default', 'web');
      const longMsg = 'hello world '.repeat(10).trim(); // len 131
      repo.appendMessage(id, { role: 'user', content: longMsg });
      repo.archive('web:default', 'user_reset');
      const res = repo.listBySessionKey({ sessionKey: 'web:default', limit: 10, offset: 0 });
      expect(res.items[0].title).toBe(`${longMsg.slice(0, 50)}…`);
      expect(res.items[0].title!.length).toBe(51);
    });

    it('keeps title untruncated when ≤ 50 chars', () => {
      const { id } = repo.findOrCreate('web:default', 'web');
      repo.appendMessage(id, { role: 'user', content: 'short message' });
      repo.archive('web:default', 'user_reset');
      const res = repo.listBySessionKey({ sessionKey: 'web:default', limit: 10, offset: 0 });
      expect(res.items[0].title).toBe('short message');
    });

    it('returns title=null when no user message', () => {
      const { id } = repo.findOrCreate('web:default', 'web');
      repo.appendMessage(id, { role: 'assistant', content: 'hi' });
      repo.archive('web:default', 'user_reset');
      const res = repo.listBySessionKey({ sessionKey: 'web:default', limit: 10, offset: 0 });
      expect(res.items[0].title).toBeNull();
    });

    it('returns title=null when first user message is all whitespace', () => {
      const { id } = repo.findOrCreate('web:default', 'web');
      repo.appendMessage(id, { role: 'user', content: '   \n\t  ' });
      repo.archive('web:default', 'user_reset');
      const res = repo.listBySessionKey({ sessionKey: 'web:default', limit: 10, offset: 0 });
      expect(res.items[0].title).toBeNull();
    });

    it('returns messageCount', () => {
      const { id } = repo.findOrCreate('web:default', 'web');
      repo.appendMessage(id, { role: 'user', content: 'a' });
      repo.appendMessage(id, { role: 'assistant', content: 'b' });
      repo.appendMessage(id, { role: 'user', content: 'c' });
      repo.archive('web:default', 'user_reset');
      const res = repo.listBySessionKey({ sessionKey: 'web:default', limit: 10, offset: 0 });
      expect(res.items[0].messageCount).toBe(3);
    });

    it('respects limit/offset', () => {
      for (let i = 0; i < 5; i++) {
        repo.findOrCreate('web:default', 'web');
        repo.archive('web:default', 'user_reset');
      }
      const page1 = repo.listBySessionKey({ sessionKey: 'web:default', limit: 2, offset: 0 });
      const page2 = repo.listBySessionKey({ sessionKey: 'web:default', limit: 2, offset: 2 });
      expect(page1.items.length).toBe(2);
      expect(page2.items.length).toBe(2);
      expect(page1.total).toBe(5);
      expect(page1.items[0].id).not.toBe(page2.items[0].id);
    });
  });

  describe('deleteById', () => {
    it('deletes conversation + cascades messages', () => {
      const { id } = repo.findOrCreate('web:default', 'web');
      repo.appendMessage(id, { role: 'user', content: 'a' });
      repo.deleteById(id);
      expect(repo.loadConversationById(id)).toBeNull();
      const msgs = testDb.db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, id))
        .all();
      expect(msgs).toEqual([]);
    });

    it('is idempotent on missing id', () => {
      expect(() => repo.deleteById(999_999)).not.toThrow();
    });
  });

  describe('unarchive', () => {
    it('archives existing active + un-archives target atomically', () => {
      const a = repo.findOrCreate('web:default', 'web').id;
      repo.archive('web:default', 'user_reset');
      const b = repo.findOrCreate('web:default', 'web').id;
      // b now active, a archived. Unarchive a → a unarchived, b archived.
      repo.unarchive(a);
      const aRow = repo.loadConversationById(a);
      const bRow = repo.loadConversationById(b);
      expect(aRow!.archivedAt).toBeNull();
      expect(bRow!.archivedAt).not.toBeNull();
    });

    it('is no-op when target already active', () => {
      const a = repo.findOrCreate('web:default', 'web').id;
      repo.unarchive(a);
      expect(repo.loadConversationById(a)!.archivedAt).toBeNull();
    });

    it('throws ConversationNotFoundError when target missing', () => {
      expect(() => repo.unarchive(99_999)).toThrow(ConversationNotFoundError);
    });

    it('un-archives target alone when no current active for sessionKey', () => {
      const a = repo.findOrCreate('web:default', 'web').id;
      repo.archive('web:default', 'user_reset');
      repo.unarchive(a);
      expect(repo.loadConversationById(a)!.archivedAt).toBeNull();
    });
  });

  describe('findOrCreate', () => {
    it('happy path: empty DB → insert + returns created=true', () => {
      const { id, created } = repo.findOrCreate('web:default', 'web');
      expect(id).toBeGreaterThan(0);
      expect(created).toBe(true);
    });

    it('returns existing when active row already present', () => {
      const { id: first } = repo.findOrCreate('web:default', 'web');
      const { id: second, created } = repo.findOrCreate('web:default', 'web');
      expect(second).toBe(first);
      expect(created).toBe(false);
    });

    it('handles SQLITE_CONSTRAINT_UNIQUE race via re-select', () => {
      // 预插一条真实的 winner row（同 sessionKey + active），模拟另一进程先插。
      testDb.db.insert(conversations).values({ sessionKey: 'web:race', channelId: 'web' }).run();
      const winnerRow = testDb.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.sessionKey, 'web:race'))
        .get();
      const winnerId = winnerRow!.id as number;

      // 关键：让 findOrCreate 的第一次 select 返 undefined（看不到 winner），
      // 让它走到 INSERT 分支 → SQLite UNIQUE violation → catch → re-select 真实走。
      const realDb = (repo as unknown as { db: typeof testDb.db }).db;
      const origSelect = realDb.select.bind(realDb);
      let callCount = 0;
      vi.spyOn(realDb, 'select').mockImplementation(((...args: Parameters<typeof origSelect>) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            from: () => ({
              where: () => ({ get: () => undefined }),
            }),
          } as unknown as ReturnType<typeof origSelect>;
        }
        return origSelect(...args);
      }) as typeof origSelect);

      const res = repo.findOrCreate('web:race', 'web');
      expect(res.id).toBe(winnerId);
      expect(res.created).toBe(false);
    });

    it('rethrows non-UNIQUE SqliteError from insert', () => {
      const realDb = (repo as unknown as { db: typeof testDb.db }).db;
      const fkErr = new SqliteError(
        'FOREIGN KEY constraint failed',
        'SQLITE_CONSTRAINT_FOREIGNKEY',
      );

      // pre-check select 返 undefined → 走 INSERT 分支；insert stub 抛非 UNIQUE error → 预期原样 rethrow
      vi.spyOn(realDb, 'select').mockImplementationOnce((() => ({
        from: () => ({ where: () => ({ get: () => undefined }) }),
      })) as unknown as typeof realDb.select);
      vi.spyOn(realDb, 'insert').mockImplementationOnce((() => ({
        values: () => ({
          returning: () => ({
            all: () => {
              throw fkErr;
            },
          }),
        }),
      })) as unknown as typeof realDb.insert);

      expect(() => repo.findOrCreate('web:fk', 'web')).toThrow('FOREIGN KEY constraint failed');
    });
  });

  describe('markBufferedWait (P2)', () => {
    it('flips status normal → buffered_wait and writes __internal.classifierDecision', () => {
      const { id: convId } = repo.findOrCreate('wait:s1', 'web');
      const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'hello' });

      const ok = repo.markBufferedWait(msgId, 1700000000000, {
        decision: 'wait',
        intent: 'create_note',
        fallbackIntent: 'create_note',
        waitReason: 'incomplete_command',
      });
      expect(ok).toBe(true);

      const row = testDb.db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.id, msgId))
        .get();
      expect(row?.status).toBe('buffered_wait');
      expect(row?.bufferedExpiresAt).toBe(1700000000000);
      const metadata = row?.metadata ? JSON.parse(row.metadata) : null;
      expect(metadata?.__internal?.classifierDecision?.intent).toBe('create_note');
      expect(metadata?.__internal?.classifierDecision?.decision).toBe('wait');
      expect(metadata?.__internal?.classifierDecision?.waitReason).toBe('incomplete_command');
    });

    it('CAS failure: returns false when message already consumed', () => {
      const { id: convId } = repo.findOrCreate('wait:s2', 'web');
      const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'q' });

      // 直接 SQL 把 status 改成 consumed 模拟 P3 cron 已经 finalize 过
      testDb.db
        .update(conversationMessages)
        .set({ status: 'consumed' })
        .where(eq(conversationMessages.id, msgId))
        .run();

      const ok = repo.markBufferedWait(msgId, 1700000000000, {});
      expect(ok).toBe(false);

      // status / bufferedExpiresAt 不应被覆盖
      const row = testDb.db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.id, msgId))
        .get();
      expect(row?.status).toBe('consumed');
      expect(row?.bufferedExpiresAt).toBeNull();
    });

    it('preserves existing user-visible metadata (does not overwrite sourceId / resultType)', () => {
      const { id: convId } = repo.findOrCreate('wait:s3', 'web');
      const { id: msgId } = repo.appendMessage(convId, {
        role: 'user',
        content: 'q',
        metadata: { resultType: 'submit', sourceId: 42 },
      });

      repo.markBufferedWait(msgId, 1700000000000, { intent: 'create_note' });

      const row = testDb.db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.id, msgId))
        .get();
      const metadata = row?.metadata ? JSON.parse(row.metadata) : null;
      expect(metadata?.sourceId).toBe(42);
      expect(metadata?.resultType).toBe('submit');
      expect(metadata?.__internal?.classifierDecision?.intent).toBe('create_note');
    });

    it('returns false when messageId does not exist', () => {
      const ok = repo.markBufferedWait(999_999, 1700000000000, { intent: 'create_note' });
      expect(ok).toBe(false);
    });

    it('handles NULL initial metadata via COALESCE (no SQL error)', () => {
      // appendMessage without metadata → metadata column is NULL
      const { id: convId } = repo.findOrCreate('wait:s4', 'web');
      const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'hello' });

      const preRow = testDb.db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.id, msgId))
        .get();
      expect(preRow?.metadata).toBeNull();

      const ok = repo.markBufferedWait(msgId, 1700000000001, { intent: 'opinion' });
      expect(ok).toBe(true);

      const row = testDb.db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.id, msgId))
        .get();
      const metadata = row?.metadata ? JSON.parse(row.metadata) : null;
      expect(metadata?.__internal?.classifierDecision?.intent).toBe('opinion');
    });

    it('concurrent simulated writes: last writer wins atomically (no JSON merge corruption)', () => {
      const { id: convId } = repo.findOrCreate('wait:s5', 'web');
      const { id: msgId } = repo.appendMessage(convId, {
        role: 'user',
        content: 'q',
        metadata: { resultType: 'submit', sourceId: 7 },
      });

      // 第一次 markBufferedWait — 应成功
      const ok1 = repo.markBufferedWait(msgId, 1700000000000, { intent: 'create_note' });
      expect(ok1).toBe(true);

      // 模拟"并发的第二次写"——因为 status 已是 buffered_wait，CAS 失败
      // 这正是 atomic UPDATE + WHERE status='normal' 的保护点：避免两步 SELECT→merge→UPDATE
      // 之间被覆盖产生 JSON 损坏 / 决策回滚
      const ok2 = repo.markBufferedWait(msgId, 1700000099999, { intent: 'opinion' });
      expect(ok2).toBe(false);

      // 第一次写的内容保留完好；user-visible 字段未被覆盖；__internal 仍是第一次的决策
      const row = testDb.db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.id, msgId))
        .get();
      expect(row?.bufferedExpiresAt).toBe(1700000000000);
      const metadata = row?.metadata ? JSON.parse(row.metadata) : null;
      expect(metadata?.sourceId).toBe(7);
      expect(metadata?.resultType).toBe('submit');
      expect(metadata?.__internal?.classifierDecision?.intent).toBe('create_note');
    });

    it('round-trip: loadContext strips __internal from message metadata', () => {
      const { id: convId } = repo.findOrCreate('wait:s6', 'web');
      const { id: msgId } = repo.appendMessage(convId, {
        role: 'user',
        content: 'hello',
        metadata: { resultType: 'submit' },
      });

      repo.markBufferedWait(msgId, 1700000000000, {
        intent: 'create_note',
        decision: 'wait',
      });

      const ctx = repo.loadContext('wait:s6', 10);
      expect(ctx).not.toBeNull();
      const recent = ctx?.recentMessages.find((m) => m.id === msgId);
      expect(recent).toBeDefined();
      expect(recent?.metadata).toEqual({ resultType: 'submit' });
      expect(recent?.metadata).not.toHaveProperty('__internal');
    });
  });

  describe('metadata __internal strip (P0.2)', () => {
    it('strips __internal namespace from loadContext recentMessages', () => {
      const { id: convId } = repo.findOrCreate('strip:s1', 'web');
      repo.appendMessage(convId, {
        role: 'assistant',
        content: 'hi',
        metadata: {
          resultType: 'submit',
          sourceId: 42,
          __internal: { classifierDecision: { intent: 'submit_url' } },
        },
      });

      const ctx = repo.loadContext('strip:s1', 10);
      expect(ctx).not.toBeNull();
      expect(ctx?.recentMessages[0].metadata).toEqual({
        resultType: 'submit',
        sourceId: 42,
      });
      expect(ctx?.recentMessages[0].metadata).not.toHaveProperty('__internal');
    });

    it('strips __internal from getMessageById', () => {
      const { id: convId } = repo.findOrCreate('strip:s2', 'web');
      const { id: msgId } = repo.appendMessage(convId, {
        role: 'assistant',
        content: 'x',
        metadata: { resultType: 'submit', __internal: { foo: 'bar' } },
      });

      const msg = repo.getMessageById(msgId);
      expect(msg).not.toBeNull();
      expect(msg?.metadata).toEqual({ resultType: 'submit' });
      expect(msg?.metadata).not.toHaveProperty('__internal');
    });

    it('strips __internal from loadConversationById messages', () => {
      const { id: convId } = repo.findOrCreate('strip:s3', 'web');
      repo.appendMessage(convId, {
        role: 'user',
        content: 'u',
      });
      repo.appendMessage(convId, {
        role: 'assistant',
        content: 'a',
        metadata: {
          resultType: 'query',
          __internal: { someServerState: 1 },
        },
      });

      const loaded = repo.loadConversationById(convId);
      expect(loaded).not.toBeNull();
      const assistantMsg = loaded?.messages.find((m) => m.role === 'assistant');
      expect(assistantMsg?.metadata).toEqual({ resultType: 'query' });
      for (const m of loaded?.messages ?? []) {
        if (m.metadata) {
          expect(m.metadata).not.toHaveProperty('__internal');
        }
      }
    });
  });
});

describe('SqliteConversationRepository — P3 buffer 方法', () => {
  describe('findActiveBufferedBySession', () => {
    it('返回当前 active 的 buffered_wait message', () => {
      const tdb = createTestDB();
      try {
        const repo = new SqliteConversationRepository(tdb.db);
        const { id: convId } = repo.findOrCreate('test:p3:1', 'test');
        const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'incomplete' });

        const future = Date.now() + 30000;
        repo.markBufferedWait(msgId, future, { fallbackIntent: 'create_note' });

        const found = repo.findActiveBufferedBySession('test:p3:1');
        expect(found).not.toBeNull();
        expect(found?.id).toBe(msgId);
        expect(found?.content).toBe('incomplete');
        expect(found?.bufferedExpiresAt).toBe(future);
        expect(found?.classifierDecision).toEqual({ fallbackIntent: 'create_note' });
      } finally {
        tdb.cleanup();
      }
    });

    it('expired buffer 不算 active（过期就排除）', () => {
      const tdb = createTestDB();
      try {
        const repo = new SqliteConversationRepository(tdb.db);
        const { id: convId } = repo.findOrCreate('test:p3:2', 'test');
        const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'expired' });

        const past = Date.now() - 1000;
        repo.markBufferedWait(msgId, past, { fallbackIntent: 'create_note' });

        const found = repo.findActiveBufferedBySession('test:p3:2');
        expect(found).toBeNull();
      } finally {
        tdb.cleanup();
      }
    });

    it('archived conversation 的 buffer 不算 active', () => {
      const tdb = createTestDB();
      try {
        const repo = new SqliteConversationRepository(tdb.db);
        const { id: convId } = repo.findOrCreate('test:p3:3', 'test');
        const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'arch' });
        repo.markBufferedWait(msgId, Date.now() + 30000, {});
        repo.archive('test:p3:3', 'user_reset');

        // archive 之后无 active conversation；findOrCreate 创新 conv
        const found = repo.findActiveBufferedBySession('test:p3:3');
        expect(found).toBeNull();
      } finally {
        tdb.cleanup();
      }
    });
  });

  describe('findPendingBufferedBySession', () => {
    it('返回 expired 但尚未 consumed 的 pending buffer', () => {
      const tdb = createTestDB();
      try {
        const repo = new SqliteConversationRepository(tdb.db);
        const { id: convId } = repo.findOrCreate('test:p3:pending-expired', 'test');
        const { id: msgId } = repo.appendMessage(convId, {
          role: 'user',
          content: 'expired but pending',
        });
        const past = Date.now() - 60_000;
        repo.markBufferedWait(msgId, past, { fallbackIntent: 'create_note' });

        expect(repo.findActiveBufferedBySession('test:p3:pending-expired')).toBeNull();
        const found = repo.findPendingBufferedBySession('test:p3:pending-expired');
        expect(found?.id).toBe(msgId);
        expect(found?.bufferedExpiresAt).toBe(past);
      } finally {
        tdb.cleanup();
      }
    });
  });

  describe('findExpiredBuffered', () => {
    it('grace 之外的 expired buffer 被返回', () => {
      const tdb = createTestDB();
      try {
        const repo = new SqliteConversationRepository(tdb.db);
        const { id: convId } = repo.findOrCreate('test:p3:exp1', 'test');
        const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'q' });

        // expires_at 在 30s grace 之外
        const longAgo = Date.now() - 60000;
        repo.markBufferedWait(msgId, longAgo, { fallbackIntent: 'create_note' });

        const list = repo.findExpiredBuffered(30000, 100);
        expect(list.find((r) => r.id === msgId)).toBeDefined();
      } finally {
        tdb.cleanup();
      }
    });

    it('grace 之内的 expired buffer 不返回（防 client clock skew 误触）', () => {
      const tdb = createTestDB();
      try {
        const repo = new SqliteConversationRepository(tdb.db);
        const { id: convId } = repo.findOrCreate('test:p3:exp2', 'test');
        const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'q' });

        // 刚过期但在 30s grace 之内
        const recentlyExpired = Date.now() - 5000;
        repo.markBufferedWait(msgId, recentlyExpired, {});

        const list = repo.findExpiredBuffered(30000, 100);
        expect(list.find((r) => r.id === msgId)).toBeUndefined();
      } finally {
        tdb.cleanup();
      }
    });

    it('limit 生效', () => {
      const tdb = createTestDB();
      try {
        const repo = new SqliteConversationRepository(tdb.db);
        for (let i = 0; i < 5; i++) {
          const { id: convId } = repo.findOrCreate(`test:p3:bulk:${i}`, 'test');
          const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: `q${i}` });
          repo.markBufferedWait(msgId, Date.now() - 60000, {});
        }
        const list = repo.findExpiredBuffered(30000, 3);
        expect(list).toHaveLength(3);
      } finally {
        tdb.cleanup();
      }
    });

    it('session-scoped query filters before applying limit', () => {
      const tdb = createTestDB();
      try {
        const repo = new SqliteConversationRepository(tdb.db);
        for (let i = 0; i < 3; i++) {
          const { id: convId } = repo.findOrCreate(`test:p3:other:${i}`, 'test');
          const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: `other${i}` });
          repo.markBufferedWait(msgId, Date.now() - 120_000 - i, {});
        }
        const { id: targetConvId } = repo.findOrCreate('test:p3:target-session', 'test');
        const { id: targetMsgId } = repo.appendMessage(targetConvId, {
          role: 'user',
          content: 'target',
        });
        repo.markBufferedWait(targetMsgId, Date.now() - 60_000, {});

        const list = repo.findExpiredBufferedBySession('test:p3:target-session', 30_000, 1);
        expect(list.map((r) => r.id)).toEqual([targetMsgId]);
      } finally {
        tdb.cleanup();
      }
    });

    it('conversation-scoped query filters before applying limit', () => {
      const tdb = createTestDB();
      try {
        const repo = new SqliteConversationRepository(tdb.db);
        const { id: targetConvId } = repo.findOrCreate('test:p3:target-conv', 'test');
        const { id: targetMsgId } = repo.appendMessage(targetConvId, {
          role: 'user',
          content: 'target',
        });
        repo.markBufferedWait(targetMsgId, Date.now() - 60_000, {});
        for (let i = 0; i < 3; i++) {
          const { id: convId } = repo.findOrCreate(`test:p3:other-conv:${i}`, 'test');
          const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: `other${i}` });
          repo.markBufferedWait(msgId, Date.now() - 120_000 - i, {});
        }

        const list = repo.findExpiredBufferedByConversation(targetConvId, 30_000, 1);
        expect(list.map((r) => r.id)).toEqual([targetMsgId]);
      } finally {
        tdb.cleanup();
      }
    });
  });

  describe('consumeBuffered (CAS)', () => {
    it('幂等：两次调用同 messageId 只有第一次返回非 null', () => {
      const tdb = createTestDB();
      try {
        const repo = new SqliteConversationRepository(tdb.db);
        const { id: convId } = repo.findOrCreate('test:p3:cas1', 'test');
        const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'q' });
        repo.markBufferedWait(msgId, Date.now() + 30000, { fallbackIntent: 'query' });

        const first = repo.consumeBuffered(msgId);
        expect(first).not.toBeNull();
        expect(first?.content).toBe('q');
        expect(first?.classifierDecision).toEqual({ fallbackIntent: 'query' });

        const second = repo.consumeBuffered(msgId);
        expect(second).toBeNull(); // CAS 失败
      } finally {
        tdb.cleanup();
      }
    });

    it('正常 message（不是 buffered_wait）调 consume → 返 null（不破坏 normal status）', () => {
      const tdb = createTestDB();
      try {
        const repo = new SqliteConversationRepository(tdb.db);
        const { id: convId } = repo.findOrCreate('test:p3:cas2', 'test');
        const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'q' });

        const out = repo.consumeBuffered(msgId);
        expect(out).toBeNull();

        // status 仍是 normal
        const row = tdb.db
          .select()
          .from(conversationMessages)
          .where(eq(conversationMessages.id, msgId))
          .get();
        expect(row?.status).toBe('normal');
      } finally {
        tdb.cleanup();
      }
    });

    it('已经 consumed 的 message 再调 consume → 返 null', () => {
      const tdb = createTestDB();
      try {
        const repo = new SqliteConversationRepository(tdb.db);
        const { id: convId } = repo.findOrCreate('test:p3:cas3', 'test');
        const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'q' });
        repo.markBufferedWait(msgId, Date.now() + 30000, {});
        repo.consumeBuffered(msgId); // 第一次成功

        const second = repo.consumeBuffered(msgId);
        expect(second).toBeNull();
      } finally {
        tdb.cleanup();
      }
    });
  });

  // describe('consumeAllBufferedInConversation') 块已删除 —— P3 第二轮 review
  // 修订：接口方法没有真实 caller（archive 必须在 tx 内 inline 写），所以
  // 测它无意义。archive 的"清 buffered" 行为由 Task 2 的 archive 测试覆盖。

  describe('loadContext 跳过 consumed', () => {
    it('consumed 消息不出现在 recentMessages 里', () => {
      const tdb = createTestDB();
      try {
        const repo = new SqliteConversationRepository(tdb.db);
        const { id: convId } = repo.findOrCreate('test:p3:loadctx', 'test');
        repo.appendMessage(convId, { role: 'user', content: 'kept' });
        const { id: drop } = repo.appendMessage(convId, { role: 'user', content: 'dropped' });
        repo.markBufferedWait(drop, Date.now() + 30000, {});
        repo.consumeBuffered(drop);
        repo.appendMessage(convId, { role: 'assistant', content: 'reply' });

        const ctx = repo.loadContext('test:p3:loadctx', 6);
        expect(ctx).not.toBeNull();
        const contents = ctx?.recentMessages.map((m) => m.content);
        expect(contents).toEqual(['kept', 'reply']); // dropped 被跳过
      } finally {
        tdb.cleanup();
      }
    });

    it('buffered_wait 消息仍出现在 recentMessages（UI 端能看见 indicator）', () => {
      const tdb = createTestDB();
      try {
        const repo = new SqliteConversationRepository(tdb.db);
        const { id: convId } = repo.findOrCreate('test:p3:loadctx2', 'test');
        const { id: bufId } = repo.appendMessage(convId, { role: 'user', content: 'waiting' });
        repo.markBufferedWait(bufId, Date.now() + 30000, {});

        const ctx = repo.loadContext('test:p3:loadctx2', 6);
        expect(ctx?.recentMessages).toHaveLength(1);
        expect(ctx?.recentMessages[0]?.status).toBe('buffered_wait');
      } finally {
        tdb.cleanup();
      }
    });
  });

  describe('markBufferedWait — P3 waitReasonKey extension', () => {
    it('markBufferedWait 写 user-visible waitReasonKey + __internal 各一份', () => {
      const tdb = createTestDB();
      try {
        const repo = new SqliteConversationRepository(tdb.db);
        const { id: convId } = repo.findOrCreate('test:p3:wrk', 'test');
        const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'q' });

        repo.markBufferedWait(
          msgId,
          Date.now() + 30000,
          { decision: 'wait', waitReason: 'incomplete_command' },
          { waitReasonKey: 'incomplete_command' },
        );

        // user-visible 字段
        const row = tdb.db
          .select()
          .from(conversationMessages)
          .where(eq(conversationMessages.id, msgId))
          .get();
        const meta = JSON.parse(row?.metadata ?? '{}') as Record<string, unknown>;
        expect(meta.waitReasonKey).toBe('incomplete_command');
        // __internal 字段仍在
        const internal = meta.__internal as {
          classifierDecision?: { waitReason?: string };
        };
        expect(internal?.classifierDecision?.waitReason).toBe('incomplete_command');

        // 模拟 GET /conversations 走 stripInternalKeys
        const ctx = repo.loadContext('test:p3:wrk', 6);
        const userMsg = ctx?.recentMessages.find((m) => m.id === msgId);
        expect(userMsg?.metadata?.waitReasonKey).toBe('incomplete_command'); // strip 后仍可见
        expect(userMsg?.metadata?.__internal).toBeUndefined(); // strip 后不见
      } finally {
        tdb.cleanup();
      }
    });
  });

  describe('SqliteConversationRepository.archive — P3 扩展', () => {
    it('archive 时同时标 buffered_wait 消息为 consumed（spec §错误处理 #11）', () => {
      const tdb = createTestDB();
      try {
        const repo = new SqliteConversationRepository(tdb.db);
        const { id: convId } = repo.findOrCreate('test:p3:arch1', 'test');
        const { id: bufId } = repo.appendMessage(convId, { role: 'user', content: 'incomplete' });
        repo.markBufferedWait(bufId, Date.now() + 30000, { fallbackIntent: 'create_note' });

        const archived = repo.archive('test:p3:arch1', 'user_reset');
        expect(archived).not.toBeNull();

        // 验证 buffered_wait 已经被同步标 consumed
        const row = tdb.db
          .select()
          .from(conversationMessages)
          .where(eq(conversationMessages.id, bufId))
          .get();
        expect(row?.status).toBe('consumed');
      } finally {
        tdb.cleanup();
      }
    });

    it('archive 不影响 normal 状态的 message', () => {
      const tdb = createTestDB();
      try {
        const repo = new SqliteConversationRepository(tdb.db);
        const { id: convId } = repo.findOrCreate('test:p3:arch2', 'test');
        const { id: msgId } = repo.appendMessage(convId, { role: 'user', content: 'normal' });

        repo.archive('test:p3:arch2', 'user_reset');

        const row = tdb.db
          .select()
          .from(conversationMessages)
          .where(eq(conversationMessages.id, msgId))
          .get();
        expect(row?.status).toBe('normal'); // 保持 normal
      } finally {
        tdb.cleanup();
      }
    });
  });
});
