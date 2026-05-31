import type { HandleInputResult } from '@goldpan/core';
import { SqliteConversationRepository } from '@goldpan/core';
import { initI18n, resetI18n } from '@goldpan/core/i18n';
import type { IntentPluginResult } from '@goldpan/core/plugins';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConversationStore, extractAssistantTurn } from '../../src/conversation/store.js';
import { createTestDB, type TestDB } from '../helpers/test-db.js';

// extractAssistantTurn 现在签名是 `T | null`（wait 路径返回 null）—— 测试里大多数
// case 期望非 null，所以加这个 narrowing helper 让 expect.toEqual 直接吃。
function expectTurn<T>(turn: T | null): T {
  if (turn === null) throw new Error('expected non-null assistant turn');
  return turn;
}

// note / tracking_pending 变体走 core.t() 渲染确认文案，需要先 initI18n。
// 其它变体不依赖 i18n —— 但 initI18n 是 idempotent（同 language 再 init 直接 return）。
beforeAll(() => initI18n('en'));
afterAll(() => resetI18n());

describe('extractAssistantTurn', () => {
  it('content variant', () => {
    const r: IntentPluginResult = { type: 'content', text: 'hello world', format: 'text' };
    expect(extractAssistantTurn(r)).toEqual({
      content: 'hello world',
      metadata: { resultType: 'content', format: 'text' },
    });
  });

  it('query variant uses result.answer', () => {
    const r: IntentPluginResult = {
      type: 'query',
      query: 'q?',
      result: {
        answer: 'because X',
        confidence: 'high',
        citedEntityIds: [1, 2],
        citedPointIds: [10],
      },
      citedEntities: [
        { id: 1, name: 'A', categoryPaths: [] },
        { id: 2, name: 'B', categoryPaths: [] },
      ],
      citedPoints: [{ id: 10, type: 'fact', content: 'p', entityId: null }],
    };
    expect(extractAssistantTurn(r)).toEqual({
      content: 'because X',
      metadata: {
        resultType: 'query',
        confidence: 'high',
        citedEntityIds: [1, 2],
        citedPointIds: [10],
      },
    });
  });

  it('submit accepted variant carries taskId + sourceId (P0.1 — classifier reads sourceId)', () => {
    const r: IntentPluginResult = {
      type: 'submit',
      result: { status: 'accepted', taskId: 7, sourceId: 42 },
    };
    const turn = expectTurn(extractAssistantTurn(r));
    expect(turn.content).toMatch(/accepted.*7/);
    expect(turn.content).not.toMatch(/42/);
    expect(turn.metadata).toMatchObject({
      resultType: 'submit',
      submitStatus: 'accepted',
      taskId: 7,
      sourceId: 42,
    });
    expect(turn.metadata).not.toHaveProperty('inputMode');
  });

  it('submit accepted carries inputMode when SubmitResult provides it', () => {
    const r: IntentPluginResult = {
      type: 'submit',
      result: { status: 'accepted', taskId: 7, sourceId: 42, inputMode: 'opinion' },
    };
    const turn = expectTurn(extractAssistantTurn(r));
    expect(turn.metadata).toMatchObject({
      resultType: 'submit',
      submitStatus: 'accepted',
      taskId: 7,
      sourceId: 42,
      inputMode: 'opinion',
    });
  });

  it('submit duplicate variant carries existing source metadata for follow-up context', () => {
    const r: IntentPluginResult = {
      type: 'submit',
      result: {
        status: 'duplicate',
        existingSourceId: 99,
        existingTaskId: 11,
        existingUrl: 'https://example.com',
      },
    };
    const turn = expectTurn(extractAssistantTurn(r));
    expect(turn.content).toMatch(/duplicate/);
    expect(turn.content).not.toMatch(/99/);
    expect(turn.metadata).toEqual({
      resultType: 'submit',
      submitStatus: 'duplicate',
      existingSourceId: 99,
      existingTaskId: 11,
      existingUrl: 'https://example.com',
    });
    expect(turn.metadata).not.toHaveProperty('sourceId');
    expect(turn.metadata).not.toHaveProperty('taskId');
  });

  it('submit rejected variant exposes reject code + reason', () => {
    const r: IntentPluginResult = {
      type: 'submit',
      result: { status: 'rejected', code: 'text_too_short', reason: 'min 4 chars' },
    };
    const turn = expectTurn(extractAssistantTurn(r));
    expect(turn.content).toMatch(/rejected.*text_too_short/);
    expect(turn.metadata).toEqual({ resultType: 'submit', submitStatus: 'rejected' });
  });

  it('clarify variant carries options (legacy)', () => {
    const r: IntentPluginResult = { type: 'clarify', question: 'which?', options: ['a', 'b'] };
    expect(extractAssistantTurn(r)).toEqual({
      content: 'which?',
      metadata: { resultType: 'clarify', options: ['a', 'b'] },
    });
  });

  it('clarify variant with P2 keyed fields preserves both shapes', () => {
    // P2: classifier 路径返回 keyed 字段；adapter 写入 metadata 时既保留 legacy
    // 又保留 keyed，render 层任选其一渲染。
    const r: IntentPluginResult = {
      type: 'clarify',
      question: 'which intent did you mean?',
      options: ['Save', 'Ask'],
      questionKey: 'ambiguous_intent',
      structuredOptions: [
        { intentKey: 'submit_url' },
        { intentKey: 'query', payload: 'about that' },
      ],
    };
    const turn = expectTurn(extractAssistantTurn(r));
    expect(turn.content).toBe('which intent did you mean?');
    expect(turn.metadata).toEqual({
      resultType: 'clarify',
      options: ['Save', 'Ask'],
      questionKey: 'ambiguous_intent',
      structuredOptions: [
        { intentKey: 'submit_url' },
        { intentKey: 'query', payload: 'about that' },
      ],
    });
  });

  it('clarify variant with only keyed fields falls back to questionKey for content', () => {
    // 外部 plugin 可能只填 keyed 字段不填 legacy question —— content 必须有兜底
    // 防止持久化空字符串。
    const r: IntentPluginResult = {
      type: 'clarify',
      questionKey: 'ambiguous_intent',
      structuredOptions: [{ intentKey: 'submit_url' }],
    };
    const turn = expectTurn(extractAssistantTurn(r));
    expect(turn.content).toBe('ambiguous_intent');
    expect(turn.metadata).toMatchObject({
      resultType: 'clarify',
      questionKey: 'ambiguous_intent',
    });
  });

  it('action variant', () => {
    const r: IntentPluginResult = { type: 'action', message: 'done', actionId: 'X' };
    expect(extractAssistantTurn(r)).toEqual({
      content: 'done',
      metadata: { resultType: 'action', actionId: 'X' },
    });
  });

  it('error variant captures code and message', () => {
    const r: HandleInputResult = {
      type: 'error',
      code: 'submit_failed',
      message: 'oops',
    };
    expect(extractAssistantTurn(r)).toEqual({
      content: 'oops',
      metadata: { resultType: 'error', code: 'submit_failed' },
    });
  });

  // ─── P2 新增 3 variants ─────────────────────────────────────────────
  // contract: wait 返回 null（不写 assistant turn —— buffer 释放路径补写）；
  // note / tracking_pending 写本地化文案 + bespoke metadata。

  it('wait variant returns null (P2 contract — no assistant turn written)', () => {
    const r: IntentPluginResult = {
      type: 'wait',
      bufferedMessageId: 100,
      expiresAt: Date.now() + 30_000,
      fallbackIntent: 'create_note',
      maxWaitMs: 30_000,
      waitReasonKey: 'incomplete_command',
    };
    expect(extractAssistantTurn(r)).toBeNull();
  });

  it('note variant renders localized confirmation + metadata with noteId/subtype', () => {
    const r: IntentPluginResult = {
      type: 'note',
      detail: {
        id: 42,
        content: 'remember to refactor classifier',
        contentTranslated: null,
        language: null,
        subtype: 'note',
        pinned: false,
        archived: false,
        sourceMessageId: null,
        conversationId: null,
        tags: [],
        linkedEntities: [],
        linkedSources: [],
        dueAt: null,
        remindedAt: null,
        createdAt: 1700000000,
        updatedAt: 1700000000,
      },
    };
    const turn = expectTurn(extractAssistantTurn(r));
    // initI18n('en') —— 走 en.json 的 "Saved as note #{noteId}"
    expect(turn.content).toBe('Saved as note #42');
    expect(turn.metadata).toEqual({
      resultType: 'note',
      noteId: 42,
      subtype: 'note',
    });
  });

  it('tracking_pending waiting_pipeline variant renders pipeline-specific text', () => {
    const r: IntentPluginResult = {
      type: 'tracking_pending',
      trackingRuleId: 7,
      reasonKey: 'waiting_pipeline',
    };
    const turn = expectTurn(extractAssistantTurn(r));
    expect(turn.content).toBe(
      'Waiting for the source analysis to finish before setting up tracking',
    );
    expect(turn.metadata).toEqual({
      resultType: 'tracking_pending',
      trackingRuleId: 7,
      reasonKey: 'waiting_pipeline',
    });
  });

  it('tracking_pending multi_entity_clarify variant renders entity-specific text', () => {
    const r: IntentPluginResult = {
      type: 'tracking_pending',
      trackingRuleId: 11,
      reasonKey: 'multi_entity_clarify',
    };
    const turn = expectTurn(extractAssistantTurn(r));
    expect(turn.content).toBe('Please pick which subject to track');
    expect(turn.metadata).toEqual({
      resultType: 'tracking_pending',
      trackingRuleId: 11,
      reasonKey: 'multi_entity_clarify',
    });
  });
});

describe('ConversationStore', () => {
  let testDb: TestDB;
  let store: ConversationStore;

  beforeEach(() => {
    testDb = createTestDB();
    const repo = new SqliteConversationRepository(testDb.db);
    store = new ConversationStore({ repo, defaultWindowSize: 8 });
  });
  afterEach(() => testDb.cleanup());

  it('loadOrCreate returns a fresh ConversationContext on first call', () => {
    const ctx = store.loadOrCreate('s', 'tg');
    expect(ctx.sessionKey).toBe('s');
    expect(ctx.recentMessages).toEqual([]);
  });

  it('appendUserTurn + appendAssistantTurn appear in subsequent loadOrCreate', () => {
    const ctx = store.loadOrCreate('s', 'tg');
    store.appendUserTurn(ctx.conversationId, 'hi');
    const written = store.appendAssistantTurn(ctx.conversationId, {
      type: 'content',
      text: 'hello',
      format: 'text',
    });
    if (written === null)
      throw new Error('expected appendAssistantTurn to persist content variant');
    expect(written.id).toBeGreaterThan(0);
    const ctx2 = store.loadOrCreate('s', 'tg');
    expect(ctx2.recentMessages.map((m) => m.content)).toEqual(['hi', 'hello']);
    expect(ctx2.recentMessages[1].id).toBe(written.id);
  });

  // P2: wait 不写 assistant turn —— appendAssistantTurn 返回 null，
  // 后续 loadOrCreate 只看到 user turn（dispatcher / server adapter 必须容忍 null）。
  it('appendAssistantTurn returns null for wait result and persists no assistant row', () => {
    const ctx = store.loadOrCreate('s2', 'tg');
    store.appendUserTurn(ctx.conversationId, 'hi');
    const written = store.appendAssistantTurn(ctx.conversationId, {
      type: 'wait',
      bufferedMessageId: 1,
      expiresAt: Date.now() + 30_000,
      fallbackIntent: 'create_note',
      maxWaitMs: 30_000,
      waitReasonKey: 'incomplete_command',
    });
    expect(written).toBeNull();
    const ctx2 = store.loadOrCreate('s2', 'tg');
    expect(ctx2.recentMessages.map((m) => m.role)).toEqual(['user']);
  });
});
