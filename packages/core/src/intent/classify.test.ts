import { describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '../conversation/types';
import type { IntentDeclaration } from '../plugins/types';
import { type ClassifyIntentDeps, classifyIntent } from './classify';

const DECLS: IntentDeclaration[] = [
  { name: 'create_note', description: 'note', priority: 0 },
  { name: 'query', description: 'query', priority: 0 },
  { name: 'submit_url', description: 'url', priority: 0 },
];

function makeDeps(
  callLlmReturn: unknown,
  overrides: Partial<ClassifyIntentDeps> = {},
): ClassifyIntentDeps {
  return {
    callLlm: vi.fn().mockResolvedValue(callLlmReturn),
    llmCallRepo: { record: vi.fn() } as never,
    language: 'en',
    logPayloads: false,
    intentDeclarations: DECLS,
    recentMessages: [],
    ...overrides,
  };
}

describe('classifyIntent v2', () => {
  it('返回 execute decision 时 caller 拿得到 intent + decision', async () => {
    const deps = makeDeps({
      decision: 'execute',
      intent: 'create_note',
      noteSubtype: 'memo',
      linkedSourceId: null,
      relatedTo: null,
    });
    const out = await classifyIntent('明天提交 PR', deps);
    expect(out.decision).toBe('execute');
    if (out.decision === 'execute') {
      expect(out.intent).toBe('create_note');
      expect(out.noteSubtype).toBe('memo');
    }
  });

  it('返回 wait decision 透传 fallbackIntent + waitReason', async () => {
    const deps = makeDeps({
      decision: 'wait',
      intent: 'create_note',
      fallbackIntent: 'create_note',
      maxWaitMs: 30000,
      waitReason: 'incomplete_command',
      relatedTo: null,
    });
    const out = await classifyIntent('明天那个...', deps);
    expect(out.decision).toBe('wait');
    if (out.decision === 'wait') {
      expect(out.fallbackIntent).toBe('create_note');
      expect(out.waitReason).toBe('incomplete_command');
    }
  });

  it('返回 clarify decision 透传 clarifyOptions', async () => {
    const deps = makeDeps({
      decision: 'clarify',
      clarifyQuestionKey: 'ambiguous_intent',
      clarifyOptions: [
        { intentKey: 'create_note' },
        { intentKey: 'query', payload: 'about goldpan' },
      ],
      relatedTo: null,
    });
    const out = await classifyIntent('goldpan', deps);
    expect(out.decision).toBe('clarify');
    if (out.decision === 'clarify') {
      expect(out.clarifyQuestionKey).toBe('ambiguous_intent');
      expect(out.clarifyOptions).toHaveLength(2);
      expect(out.clarifyOptions[0]?.intentKey).toBe('create_note');
    }
  });

  it('recentMessages 中的 __internal 在调 callLlm 前被 strip', async () => {
    const callLlm = vi.fn().mockResolvedValue({
      decision: 'execute',
      intent: 'create_note',
      relatedTo: null,
    });
    const recentMessages: ConversationMessage[] = [
      {
        id: 1,
        role: 'assistant',
        content: 'ok',
        createdAt: new Date('2026-05-17T10:00:00Z'),
        metadata: {
          sourceId: 7,
          __internal: { classifierDecision: { intent: 'x' } },
        },
      },
    ];
    const deps = makeDeps(undefined, { callLlm, recentMessages });
    await classifyIntent('继续', deps);

    // prompt 字符串里只能看到 sourceId=7，不能看到 __internal 字面量
    const lastCall = callLlm.mock.calls[0]?.[0];
    expect(lastCall?.prompt).toContain('sourceId=7');
    expect(lastCall?.prompt).not.toContain('__internal');
    expect(lastCall?.prompt).not.toContain('classifierDecision');
  });

  it('recentMessages content 超过 500 字符时被截断', async () => {
    const callLlm = vi.fn().mockResolvedValue({
      decision: 'execute',
      intent: 'create_note',
      relatedTo: null,
    });
    const longContent = `${'A'.repeat(800)}TAIL`;
    const recentMessages: ConversationMessage[] = [
      {
        id: 99,
        role: 'user',
        content: longContent,
        createdAt: new Date('2026-05-17T10:00:00Z'),
        metadata: { sourceId: 12 },
      },
    ];
    const deps = makeDeps(undefined, { callLlm, recentMessages });
    await classifyIntent('继续', deps);

    const lastCall = callLlm.mock.calls[0]?.[0];
    // 截断后 prompt 中不会出现 TAIL 标记，但 sourceId=12 仍在
    expect(lastCall?.prompt).not.toContain('TAIL');
    expect(lastCall?.prompt).toContain('sourceId=12');
    // 总长不可能超过 prompt 的其它框架文字 + 500 字符内容 + ellipsis
    const aRuns: string[] = lastCall?.prompt.match(/A+/g) ?? [];
    const longestArun = aRuns.reduce((max, s) => Math.max(max, s.length), 0);
    expect(longestArun).toBeLessThanOrEqual(500);
  });

  it('classifyIntent 注入空 recentMessages 时 prompt 不含 history 段', async () => {
    const callLlm = vi.fn().mockResolvedValue({
      decision: 'execute',
      intent: 'query',
      relatedTo: null,
    });
    const deps = makeDeps(undefined, { callLlm });
    await classifyIntent('what is goldpan', deps);
    const lastCall = callLlm.mock.calls[0]?.[0];
    expect(lastCall?.prompt).not.toContain('Conversation history');
  });

  it('classifyIntent 未提供 recentMessages 时 prompt 不含 history 段', async () => {
    const callLlm = vi.fn().mockResolvedValue({
      decision: 'execute',
      intent: 'query',
      relatedTo: null,
    });
    const deps: ClassifyIntentDeps = {
      callLlm,
      llmCallRepo: { record: vi.fn() } as never,
      language: 'en',
      logPayloads: false,
      intentDeclarations: DECLS,
      // 注意：不传 recentMessages
    };
    await classifyIntent('what is goldpan', deps);
    const lastCall = callLlm.mock.calls[0]?.[0];
    expect(lastCall?.prompt).not.toContain('Conversation history');
  });
});
