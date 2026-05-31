import { describe, expect, it } from 'vitest';
import { compilePrompt, loadPromptTemplate } from './loader';

describe('intent_classifier prompts', () => {
  it('system prompt 含 Decision 三档说明', () => {
    const tmpl = loadPromptTemplate('intent_classifier-system', 'en');
    const out = compilePrompt(tmpl, {
      intents: [
        { name: 'create_note', description: 'Save personal note', examples: ['idea: ...'] },
      ],
      classificationHints: ['note hint'],
    });
    expect(out).toMatch(/decision/i);
    expect(out).toContain('execute');
    expect(out).toContain('wait');
    expect(out).toContain('clarify');
    expect(out).toMatch(/note subtype/i);
    expect(out).toMatch(/wait reason/i);
  });

  it('system prompt 列出 fallback intent 白名单', () => {
    const tmpl = loadPromptTemplate('intent_classifier-system', 'en');
    const out = compilePrompt(tmpl, { intents: [], classificationHints: [] });
    expect(out).toContain('submit_url');
    expect(out).toContain('query');
    expect(out).toContain('create_note');
  });

  it('zh system prompt only documents current note subtype enum', () => {
    const tmpl = loadPromptTemplate('intent_classifier-system', 'zh');
    const out = compilePrompt(tmpl, { intents: [], classificationHints: [] });
    expect(out).toContain('`memo`');
    expect(out).toContain('`note`');
    expect(out).not.toContain('`idea`');
    expect(out).not.toContain('`reflection`');
    expect(out).not.toContain('`observation`');
  });

  it('user prompt 渲染 recentMessages 含 metadata.sourceId', () => {
    const tmpl = loadPromptTemplate('intent_classifier', 'en');
    const out = compilePrompt(tmpl, {
      intentNames: ['create_note'],
      userInput: '追踪这家公司',
      recentMessages: [
        {
          id: 7,
          role: 'user',
          content: '看下 https://example.com',
          elapsed: '2 minutes ago',
          metadata: { sourceId: 42 },
        },
        {
          id: 8,
          role: 'assistant',
          content: '已提交',
          elapsed: '1 minute ago',
          metadata: { sourceId: 42, taskId: 9 },
        },
      ],
    });
    // 关键断言：sourceId=42 出现在 prompt 里，让 LLM 看见前置 source 上下文
    expect(out).toContain('sourceId=42');
    expect(out).toContain('id=7');
    expect(out).toContain('id=8');
    expect(out).toContain('追踪这家公司');
  });

  it('user prompt 把 duplicate existingSourceId 渲染成可引用的 sourceId', () => {
    const tmpl = loadPromptTemplate('intent_classifier', 'en');
    const out = compilePrompt(tmpl, {
      intentNames: ['create_tracking'],
      userInput: 'track that',
      recentMessages: [
        {
          id: 9,
          role: 'assistant',
          content: 'duplicate — already submitted',
          elapsed: '10 seconds ago',
          metadata: { existingSourceId: 77 },
        },
      ],
    });
    expect(out).toContain('sourceId=77');
    expect(out).not.toContain('existingSourceId');
  });

  it('user prompt 在 recentMessages 为空时正常渲染', () => {
    const tmpl = loadPromptTemplate('intent_classifier', 'en');
    const out = compilePrompt(tmpl, {
      intentNames: ['create_note'],
      userInput: 'hello',
      recentMessages: [],
    });
    expect(out).toContain('hello');
    expect(out).not.toContain('sourceId=');
  });
});
