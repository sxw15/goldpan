import { describe, expect, it } from 'vitest';
import {
  extractAssistantTurn,
  writeAssistantTurnForResult,
} from '../../src/conversation/assistant-turn.js';
import { SqliteConversationRepository } from '../../src/db/repositories/conversation.repository.js';
import { createTestDB } from '../helpers/test-db.js';

// note / tracking_pending 变体走 core.t() 渲染确认文案 —— core 的 tests/helpers/i18n.ts
// setup file 已经在每个 test 前 initI18n('en')，本文件无需再初始化。

describe('writeAssistantTurnForResult', () => {
  it('submit accepted → 写 assistant turn with taskId / sourceId metadata', () => {
    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = repo.findOrCreate('t:1', 'test');
      const ret = writeAssistantTurnForResult({
        repo,
        conversationId: convId,
        result: {
          type: 'submit',
          result: {
            status: 'accepted',
            taskId: 7,
            sourceId: 42,
            warnings: [],
            inputMode: 'opinion',
          },
        },
      });
      expect(ret?.id).toBeDefined();
      const ctx = repo.loadContext('t:1', 6);
      const last = ctx?.recentMessages.at(-1);
      expect(last?.role).toBe('assistant');
      expect(last?.metadata?.taskId).toBe(7);
      expect(last?.metadata?.sourceId).toBe(42);
      expect(last?.metadata?.inputMode).toBe('opinion');
    } finally {
      tdb.cleanup();
    }
  });

  it('note → 写 i18n-翻译后的 content + noteId metadata', () => {
    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = repo.findOrCreate('t:2', 'test');
      writeAssistantTurnForResult({
        repo,
        conversationId: convId,
        result: {
          type: 'note',
          detail: {
            id: 99,
            content: 'x',
            contentTranslated: null,
            language: null,
            subtype: 'note',
            pinned: false,
            archived: false,
            sourceMessageId: null,
            tags: [],
            linkedEntities: [],
            linkedSources: [],
            createdAt: 1700000000,
            updatedAt: 1700000000,
          },
        },
      });
      const ctx = repo.loadContext('t:2', 6);
      const last = ctx?.recentMessages.at(-1);
      // initI18n('en') → "Saved as note #99"
      expect(last?.content).toMatch(/note/i);
      expect(last?.content).toContain('99');
      expect(last?.metadata?.noteId).toBe(99);
      expect(last?.metadata?.subtype).toBe('note');
    } finally {
      tdb.cleanup();
    }
  });

  it('tracking_pending → 按 reasonKey 选不同文案', () => {
    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = repo.findOrCreate('t:3', 'test');
      writeAssistantTurnForResult({
        repo,
        conversationId: convId,
        result: {
          type: 'tracking_pending',
          trackingRuleId: 5,
          reasonKey: 'waiting_pipeline',
        },
      });
      const last = repo.loadContext('t:3', 6)?.recentMessages.at(-1);
      expect(last?.metadata?.trackingRuleId).toBe(5);
      expect(last?.metadata?.reasonKey).toBe('waiting_pipeline');
      expect(last?.content).toMatch(/Waiting for the source analysis/);
    } finally {
      tdb.cleanup();
    }
  });

  it('clarify → 写 questionKey 翻译后的 content + structuredOptions metadata', () => {
    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = repo.findOrCreate('t:4', 'test');
      writeAssistantTurnForResult({
        repo,
        conversationId: convId,
        result: {
          type: 'clarify',
          questionKey: 'ambiguous_intent',
          structuredOptions: [{ intentKey: 'submit_url' }],
          question: 'fallback q',
          options: ['Save as note'],
        },
      });
      const last = repo.loadContext('t:4', 6)?.recentMessages.at(-1);
      expect(last?.metadata?.questionKey).toBe('ambiguous_intent');
      expect(last?.metadata?.structuredOptions).toEqual([{ intentKey: 'submit_url' }]);
      // legacy question wins for content when both present
      expect(last?.content).toBe('fallback q');
    } finally {
      tdb.cleanup();
    }
  });

  it('wait result → 不写 turn（return null）', () => {
    const tdb = createTestDB();
    try {
      const repo = new SqliteConversationRepository(tdb.db);
      const { id: convId } = repo.findOrCreate('t:5', 'test');
      const ret = writeAssistantTurnForResult({
        repo,
        conversationId: convId,
        result: {
          type: 'wait',
          bufferedMessageId: 1,
          expiresAt: Date.now() + 30_000,
          fallbackIntent: 'create_note',
          maxWaitMs: 30_000,
          waitReasonKey: 'incomplete_command',
        },
      });
      expect(ret).toBeNull();
      // extractAssistantTurn 直接返 null 也验证一次
      expect(
        extractAssistantTurn({
          type: 'wait',
          bufferedMessageId: 1,
          expiresAt: Date.now() + 30_000,
          fallbackIntent: 'create_note',
          maxWaitMs: 30_000,
          waitReasonKey: 'incomplete_command',
        }),
      ).toBeNull();
      // 没有 assistant turn
      const ctx = repo.loadContext('t:5', 6);
      expect(ctx?.recentMessages).toHaveLength(0);
    } finally {
      tdb.cleanup();
    }
  });
});
