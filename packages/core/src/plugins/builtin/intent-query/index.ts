import { MAX_QUERY_LENGTH, queryKnowledge } from '../../../query/index';
import type { IntentPlugin, ResolvedEntity, ResolvedKnowledgePoint } from '../../types';

export const intentQueryPlugin: IntentPlugin = {
  name: 'intent-query',
  version: '1.0.0',
  type: 'intent',
  description: 'Built-in plugin for querying the knowledge base',

  intents: [
    {
      name: 'query',
      description: 'User asks a question or searches for information from the knowledge base',
      descriptions: {
        zh: '用户提出问题或从知识库中搜索信息',
      },
      examples: ['What do I know about TypeScript?', 'Summarize recent AI developments'],
      classificationHints: [
        'If the user is clearly asking a question or trying to recall/find something, choose `query`',
        'When ambiguous between `query` and `submit_text`, prefer `query` if there is any interrogative tone',
      ],
      priority: 0,
      maxInputLength: MAX_QUERY_LENGTH,
      resultTypes: ['query'],
    },
  ],

  async execute(_intent, input, ctx, signal) {
    const result = await queryKnowledge(input, {
      db: ctx.db,
      callLlm: ctx.callLlm,
      llmCallRepo: ctx.llmCallRepo,
      language: ctx.language,
      logPayloads: ctx.logPayloads,
      llmTimeout: ctx.llmTimeout,
      signal,
      embeddingProvider: ctx.embeddingProvider,
      logger: ctx.logger,
      conversation: ctx.conversation,
    });

    // getEntitiesByIds 返回任意顺序（见 knowledge.test.ts 断言），
    // 但前端按 citedEntities 数组顺序渲染 chips，所以必须按 citedEntityIds 重排。
    let citedEntities: ResolvedEntity[] = [];
    if (result.citedEntityIds.length > 0) {
      const fetched = ctx.repos.knowledge.getEntitiesByIds(result.citedEntityIds);
      const byId = new Map(fetched.map((e) => [e.id, e]));
      citedEntities = result.citedEntityIds
        .map((id) => byId.get(id))
        .filter((e): e is NonNullable<typeof e> => e != null)
        .map((e) => ({ id: e.id, name: e.name, categoryPaths: e.categoryPaths ?? [] }));
    }

    const citedPoints: ResolvedKnowledgePoint[] =
      result.citedPointIds.length > 0
        ? ctx.repos.knowledge.getPointsByIds(result.citedPointIds).map((p) => ({
            id: p.id,
            type: p.type as 'fact' | 'opinion',
            content: p.content,
            entityId: null,
          }))
        : [];

    return { type: 'query', result, query: input, citedEntities, citedPoints };
  },
};
