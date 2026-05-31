import { describe, expect, it } from 'vitest';
import { INTENT_RESULT_TYPES, type IntentPluginResult } from './types';

describe('IntentPluginResult v2 type coverage', () => {
  it('INTENT_RESULT_TYPES 包含 wait / note / tracking_pending', () => {
    expect(INTENT_RESULT_TYPES).toContain('wait');
    expect(INTENT_RESULT_TYPES).toContain('note');
    expect(INTENT_RESULT_TYPES).toContain('tracking_pending');
  });

  it('clarify keyed 字段：questionKey + structuredOptions', () => {
    const v: IntentPluginResult = {
      type: 'clarify',
      questionKey: 'ambiguous_intent',
      structuredOptions: [{ intentKey: 'create_note' }, { intentKey: 'query', payload: 'AI' }],
      // legacy 字段（handleInput 自动填，供 legacy UI / IM 渲染）
      question: 'What did you mean?',
      options: ['Save as note', 'Query knowledge'],
    };
    expect(v.type).toBe('clarify');
    if (v.type === 'clarify') {
      expect(v.structuredOptions).toHaveLength(2);
      expect(v.questionKey).toBe('ambiguous_intent');
    }
  });

  it('clarify legacy 字段：兼容外部 plugin 仅返 question/options', () => {
    // tracking / github-intent / digest plugin 沿用此 shape，编译应通过
    const v: IntentPluginResult = {
      type: 'clarify',
      question: 'Which interest do you want to delete?',
      options: ['#1 foo', '#2 bar'],
    };
    expect(v.type).toBe('clarify');
  });

  it('wait 变体携带 bufferedMessageId 与 expiresAt', () => {
    const v: IntentPluginResult = {
      type: 'wait',
      bufferedMessageId: 42,
      expiresAt: 1700000000000,
      fallbackIntent: 'create_note',
      maxWaitMs: 30000,
      waitReasonKey: 'incomplete_command',
    };
    expect(v.type).toBe('wait');
  });

  it('note 变体携带 NoteDetail', () => {
    const v: IntentPluginResult = {
      type: 'note',
      detail: {
        id: 1,
        content: 'x',
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
        createdAt: 0,
        updatedAt: 0,
      },
    };
    expect(v.type).toBe('note');
  });

  it('tracking_pending 变体携带 trackingRuleId + reason', () => {
    const v: IntentPluginResult = {
      type: 'tracking_pending',
      trackingRuleId: 7,
      reasonKey: 'waiting_pipeline',
    };
    expect(v.type).toBe('tracking_pending');
  });
});
