import { describe, expect, it } from 'vitest';
import { findAndMergeBuffered } from '../../src/conversation/buffer-merge.js';
import { SqliteConversationRepository } from '../../src/db/repositories/conversation.repository.js';
import { createTestDB } from '../helpers/test-db.js';

describe('findAndMergeBuffered', () => {
  it('有 active buffered → 合并 + 标 consumed', () => {
    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = repo.findOrCreate('t:m:1', 'test');
      const { id: bufId } = repo.appendMessage(convId, { role: 'user', content: '明天那个' });
      repo.markBufferedWait(bufId, Date.now() + 30000, { fallbackIntent: 'create_note' });

      const out = findAndMergeBuffered('t:m:1', '提交 PR', { repo });
      expect(out.merged).toBe(true);
      expect(out.input).toBe('明天那个\n\n提交 PR');
      expect(out.previousMessageId).toBe(bufId);

      // 原 buffered 已经 consumed → loadContext 跳过 consumed message
      const ctx = repo.loadContext('t:m:1', 6);
      expect(ctx?.recentMessages.find((m) => m.id === bufId)).toBeUndefined();
    } finally {
      tdb.cleanup();
    }
  });

  it('无 buffered → 返回原 input 不做事', () => {
    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = repo.findOrCreate('t:m:2', 'test');
      repo.appendMessage(convId, { role: 'user', content: 'history' });

      const out = findAndMergeBuffered('t:m:2', '新消息', { repo });
      expect(out.merged).toBe(false);
      expect(out.input).toBe('新消息');
      expect(out.previousMessageId).toBeUndefined();
    } finally {
      tdb.cleanup();
    }
  });

  it('expired buffer 不合并（spec §"buffer expiration" 中由 Path C/E 处理）', () => {
    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = repo.findOrCreate('t:m:3', 'test');
      const { id: bufId } = repo.appendMessage(convId, { role: 'user', content: 'old' });
      repo.markBufferedWait(bufId, Date.now() - 60000, { fallbackIntent: 'create_note' });

      const out = findAndMergeBuffered('t:m:3', 'new', { repo });
      expect(out.merged).toBe(false);
      expect(out.input).toBe('new');
    } finally {
      tdb.cleanup();
    }
  });

  it('CAS race：consumeBuffered 期间被并发 finalize → 返回非 merged', () => {
    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = repo.findOrCreate('t:m:4', 'test');
      const { id: bufId } = repo.appendMessage(convId, { role: 'user', content: 'x' });
      repo.markBufferedWait(bufId, Date.now() + 30000, {});
      // 模拟并发：先消费一次 → findActiveBufferedBySession 不再返回它
      // （findActiveBufferedBySession 内部按 status='buffered_wait' 过滤）
      repo.consumeBuffered(bufId);

      const out = findAndMergeBuffered('t:m:4', 'new', { repo });
      expect(out.merged).toBe(false);
      expect(out.input).toBe('new');
    } finally {
      tdb.cleanup();
    }
  });
});
