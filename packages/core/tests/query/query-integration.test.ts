import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRawDatabase } from '../../src/db/connection.js';
import { NOW_MS_SQL } from '../../src/db/sql-fragments.js';
import { queryKnowledge } from '../../src/query/index.js';
import { createTestDB, type TestDB } from '../helpers/test-db.js';
import {
  createMockCallLlm,
  createMockLlmCallRepo,
  resetIdSequences,
} from '../pipeline/fixtures/index.js';
import '../helpers/i18n.js';

vi.mock('../../src/prompts/loader.js', () => ({
  loadPromptTemplate: vi.fn().mockReturnValue('mock template'),
  compilePrompt: vi.fn().mockImplementation((_t: string, vars: any) => JSON.stringify(vars)),
  computePromptHash: vi.fn().mockReturnValue('abc12345'),
}));

describe('queryKnowledge integration (real DB + mock LLM)', () => {
  let testDB: TestDB;
  let mockLlm: ReturnType<typeof createMockCallLlm>;
  let llmCallRepo: ReturnType<typeof createMockLlmCallRepo>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetIdSequences();
    testDB = createTestDB();
    mockLlm = createMockCallLlm();
    llmCallRepo = createMockLlmCallRepo();
    seedData(testDB);
  });

  afterEach(() => {
    testDB.cleanup();
  });

  const baseDeps = () => ({
    db: testDB.db,
    callLlm: mockLlm.fn,
    llmCallRepo,
    language: 'en' as const,
    logPayloads: false,
    llmTimeout: 30,
  });

  it('full flow: understand → search → answer with matching entities', async () => {
    // Step 1 mock: understandQuery returns structured search params
    mockLlm.fn.mockResolvedValueOnce({
      keywords: ['React', 'virtual DOM'],
      hasTimeHint: false,
      categoryHints: [],
      pointType: 'any',
      sourceKind: 'any',
    });

    // Step 3 mock: generateQueryAnswer synthesizes an answer
    const expectedAnswer = {
      answer: 'React uses a virtual DOM for efficient UI rendering.',
      citedEntityIds: [1],
      citedPointIds: [1],
      confidence: 'high' as const,
    };
    mockLlm.fn.mockResolvedValueOnce(expectedAnswer);

    const result = await queryKnowledge('How does React render?', baseDeps());

    expect(result.answer).toBe(expectedAnswer.answer);
    expect(result.confidence).toBe('high');
    expect(result.citedEntityIds).toEqual([1]);
    expect(mockLlm.fn).toHaveBeenCalledTimes(2);
    expect(mockLlm.fn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ step: 'query_understand' }),
    );
    expect(mockLlm.fn).toHaveBeenNthCalledWith(2, expect.objectContaining({ step: 'query' }));
  });

  it('full flow: no matching data returns no_data confidence', async () => {
    mockLlm.fn.mockResolvedValueOnce({
      keywords: ['nonexistent_topic_xyz'],
      hasTimeHint: false,
      categoryHints: [],
      pointType: 'any',
      sourceKind: 'any',
    });

    const noDataAnswer = {
      answer: 'No relevant knowledge found for this topic.',
      citedEntityIds: [],
      citedPointIds: [],
      confidence: 'no_data' as const,
    };
    mockLlm.fn.mockResolvedValueOnce(noDataAnswer);

    const result = await queryKnowledge('What is NonexistentThing?', baseDeps());

    expect(result.confidence).toBe('no_data');
    expect(result.citedEntityIds).toEqual([]);
  });

  it('rejects empty query', async () => {
    await expect(queryKnowledge('', baseDeps())).rejects.toThrow();
    expect(mockLlm.fn).not.toHaveBeenCalled();
  });

  it('rejects query exceeding MAX_QUERY_LENGTH', async () => {
    const longQuery = 'a'.repeat(2001);
    await expect(queryKnowledge(longQuery, baseDeps())).rejects.toThrow();
    expect(mockLlm.fn).not.toHaveBeenCalled();
  });

  it('wraps understandQuery LLM failure', async () => {
    mockLlm.fn.mockRejectedValueOnce(new Error('rate limit'));

    await expect(queryKnowledge('Some query', baseDeps())).rejects.toThrow(
      /Query understanding failed/i,
    );
  });

  it('wraps generateQueryAnswer LLM failure', async () => {
    mockLlm.fn.mockResolvedValueOnce({
      keywords: ['React'],
      hasTimeHint: false,
      categoryHints: [],
      pointType: 'any',
      sourceKind: 'any',
    });
    mockLlm.fn.mockRejectedValueOnce(new Error('model overloaded'));

    await expect(queryKnowledge('What is React?', baseDeps())).rejects.toThrow(
      /Answer generation failed/i,
    );
  });

  it('handles time-hint queries with real DB', async () => {
    mockLlm.fn.mockResolvedValueOnce({
      keywords: [],
      hasTimeHint: true,
      categoryHints: [],
      pointType: 'any',
      sourceKind: 'any',
    });

    const answer = {
      answer: 'Recent knowledge includes React and Vue.',
      citedEntityIds: [1, 2],
      citedPointIds: [1, 4],
      confidence: 'medium' as const,
    };
    mockLlm.fn.mockResolvedValueOnce(answer);

    const result = await queryKnowledge('What was recently added?', baseDeps());
    expect(result.confidence).toBe('medium');
  });

  it('dedupes citedEntityIds and citedPointIds when LLM returns duplicates', async () => {
    mockLlm.fn.mockResolvedValueOnce({
      keywords: ['React'],
      hasTimeHint: false,
      categoryHints: [],
      pointType: 'any',
      sourceKind: 'any',
    });
    // LLM 返回重复 id 的极端情况（长答案里反复引同一 entity/point）
    mockLlm.fn.mockResolvedValueOnce({
      answer: 'React virtual DOM and React hooks…',
      citedEntityIds: [1, 1, 1],
      citedPointIds: [1, 1, 2, 2],
      confidence: 'high' as const,
    });

    const result = await queryKnowledge('Tell me about React', baseDeps());

    // 保留首次出现顺序，重复 id 被去掉
    expect(result.citedEntityIds).toEqual([1]);
    expect(result.citedPointIds).toEqual([1, 2]);
  });

  describe('multi-turn conversation context', () => {
    const buildConversation = () => ({
      sessionKey: 'tg:chat-1',
      conversationId: 1,
      channelId: 'telegram',
      messageWindowSize: 8,
      startedAt: new Date('2025-01-01T00:00:00Z'),
      recentMessages: [
        {
          id: 1,
          role: 'user' as const,
          content: 'What is React?',
          createdAt: new Date('2025-01-01T00:00:01Z'),
        },
        {
          id: 2,
          role: 'assistant' as const,
          content: 'React is a JavaScript library for building UIs.',
          createdAt: new Date('2025-01-01T00:00:02Z'),
        },
      ],
    });

    it('forwards conversation turns into BOTH the understand and answer prompts', async () => {
      mockLlm.fn.mockResolvedValueOnce({
        keywords: ['React', 'virtual DOM'],
        hasTimeHint: false,
        categoryHints: [],
        pointType: 'any',
        sourceKind: 'any',
      });
      mockLlm.fn.mockResolvedValueOnce({
        answer: 'React uses a virtual DOM.',
        citedEntityIds: [1],
        citedPointIds: [1],
        confidence: 'high' as const,
      });

      await queryKnowledge('how does it render?', {
        ...baseDeps(),
        conversation: buildConversation(),
      });

      // Both LLM calls should receive serialized turns in their prompt.
      const understandCall = mockLlm.fn.mock.calls[0][0];
      const answerCall = mockLlm.fn.mock.calls[1][0];
      expect(understandCall.prompt).toContain('"hasConversation":true');
      expect(understandCall.prompt).toContain('"role":"user"');
      expect(understandCall.prompt).toContain('What is React?');
      expect(answerCall.prompt).toContain('"hasConversation":true');
      expect(answerCall.prompt).toContain('React is a JavaScript library for building UIs.');
    });

    it('omits conversation block when no conversation is provided (single-turn unchanged)', async () => {
      mockLlm.fn.mockResolvedValueOnce({
        keywords: ['React'],
        hasTimeHint: false,
        categoryHints: [],
        pointType: 'any',
        sourceKind: 'any',
      });
      mockLlm.fn.mockResolvedValueOnce({
        answer: 'React is a UI library.',
        citedEntityIds: [1],
        citedPointIds: [],
        confidence: 'high' as const,
      });

      await queryKnowledge('What is React?', baseDeps());

      const understandCall = mockLlm.fn.mock.calls[0][0];
      const answerCall = mockLlm.fn.mock.calls[1][0];
      expect(understandCall.prompt).toContain('"hasConversation":false');
      expect(answerCall.prompt).toContain('"hasConversation":false');
    });

    it('omits conversation block when recentMessages is empty (fresh conversation)', async () => {
      mockLlm.fn.mockResolvedValueOnce({
        keywords: ['React'],
        hasTimeHint: false,
        categoryHints: [],
        pointType: 'any',
        sourceKind: 'any',
      });
      mockLlm.fn.mockResolvedValueOnce({
        answer: 'React is a UI library.',
        citedEntityIds: [1],
        citedPointIds: [],
        confidence: 'high' as const,
      });

      await queryKnowledge('What is React?', {
        ...baseDeps(),
        conversation: { ...buildConversation(), recentMessages: [] },
      });

      const understandCall = mockLlm.fn.mock.calls[0][0];
      expect(understandCall.prompt).toContain('"hasConversation":false');
    });
  });
});

function seedData(testDB: TestDB): void {
  const raw = getRawDatabase(testDB.db);
  raw.exec(`
    INSERT INTO categories (id, name, path, parent_id)
      VALUES (1, 'Tech', '/Tech', NULL);
    INSERT INTO categories (id, name, path, parent_id)
      VALUES (2, 'Frontend', '/Tech/Frontend', 1);

    INSERT INTO entities (id, name, description, aliases, keywords)
      VALUES (1, 'React', 'A JavaScript library for building UIs', '["ReactJS"]', '["frontend", "UI", "JavaScript"]');
    INSERT INTO entities (id, name, description, aliases, keywords)
      VALUES (2, 'Vue', 'Progressive JavaScript framework', '["VueJS"]', '["frontend", "framework"]');

    INSERT INTO entity_categories (entity_id, category_id)
      VALUES (1, 2);
    INSERT INTO entity_categories (entity_id, category_id)
      VALUES (2, 2);

    INSERT INTO knowledge_points (id, content, type, status)
      VALUES (1, 'React uses a virtual DOM for efficient rendering', 'fact', 'active');
    INSERT INTO knowledge_points (id, content, type, status)
      VALUES (2, 'React hooks simplify state management', 'fact', 'active');
    INSERT INTO knowledge_points (id, content, type, status)
      VALUES (3, 'I think React is great for large apps', 'opinion', 'active');
    INSERT INTO knowledge_points (id, content, type, status)
      VALUES (4, 'Vue has a gentle learning curve', 'fact', 'active');

    INSERT INTO sources (id, kind, normalized_url, original_url, raw_content, status, created_at)
      VALUES (1, 'external', 'https://example.com/react', 'https://example.com/react', NULL, 'confirmed', ${NOW_MS_SQL});
    INSERT INTO sources (id, kind, normalized_url, original_url, raw_content, status, created_at)
      VALUES (2, 'user', NULL, NULL, 'Vue is easy to learn', 'confirmed', ${NOW_MS_SQL});

    INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
      VALUES (1, 1, 1, 'new');
    INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
      VALUES (1, 1, 2, 'new');
    INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
      VALUES (1, 1, 3, 'new');
    INSERT INTO source_entity_points (source_id, entity_id, point_id, judgment)
      VALUES (2, 2, 4, 'new');
  `);
}
