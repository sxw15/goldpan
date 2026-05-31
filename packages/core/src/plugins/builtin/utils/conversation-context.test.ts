import { describe, expect, it } from 'vitest';
import { collectMentionedSourceIds } from './conversation-context';

describe('collectMentionedSourceIds', () => {
  it('从 assistant turn metadata.sourceId 收集', () => {
    const set = collectMentionedSourceIds([
      {
        id: 1,
        role: 'assistant',
        content: 'ok',
        createdAt: new Date(),
        metadata: { sourceId: 42 },
      },
      {
        id: 2,
        role: 'user',
        content: 'q',
        createdAt: new Date(),
      },
    ]);
    expect(set.has(42)).toBe(true);
    expect(set.size).toBe(1);
  });

  it('从 duplicate response 的 existingSourceId 收集', () => {
    const set = collectMentionedSourceIds([
      {
        id: 1,
        role: 'assistant',
        content: 'duplicate',
        createdAt: new Date(),
        metadata: { existingSourceId: 7 },
      },
    ]);
    expect(set.has(7)).toBe(true);
  });

  it('忽略非数字 sourceId（防 LLM hallucinate）', () => {
    const set = collectMentionedSourceIds([
      {
        id: 1,
        role: 'assistant',
        content: '',
        createdAt: new Date(),
        metadata: { sourceId: 'abc' },
      },
    ]);
    expect(set.size).toBe(0);
  });

  it('undefined 输入返回空 Set', () => {
    expect(collectMentionedSourceIds(undefined).size).toBe(0);
    expect(collectMentionedSourceIds([]).size).toBe(0);
  });
});
