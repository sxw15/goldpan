import type { ILogObj, Logger } from 'tslog';
import { type DrizzleDB, getRawDatabase } from '../../db/connection';
import { parseJsonStringArray } from '../../db/json-columns';
import type { KnowledgeRepository, LlmCallRepository } from '../../db/repositories/types';
import type { EmbeddingProvider } from '../../embedding/types';
import { errorMessage } from '../../errors';
import { t } from '../../i18n/index';
import { compilePrompt, computePromptHash, loadPromptTemplate } from '../../prompts/loader';
import {
  type CallLlmFn,
  type MatchingOutput,
  matchingSchema,
  type PipelineContext,
  PipelineError,
} from '../types';
import { prefilterEntities, shouldPrefilter } from './matching-prefilter';

export interface MatchingDeps {
  callLlm: CallLlmFn;
  llmCallRepo: LlmCallRepository;
  knowledgeRepo: KnowledgeRepository;
  embeddingProvider?: EmbeddingProvider | null;
  db: DrizzleDB;
  logger?: Logger<ILogObj>;
}

export async function executeMatching(
  ctx: PipelineContext,
  deps: MatchingDeps,
): Promise<PipelineContext> {
  const entityRegistry = deps.knowledgeRepo.getEntityRegistry();

  let effectiveRegistry = entityRegistry;
  let pointEmbeddingsCache: Map<string, number[]> | undefined;

  const embeddingProvider = deps.embeddingProvider;
  if (
    embeddingProvider != null &&
    shouldPrefilter(embeddingProvider, deps.db, entityRegistry.length)
  ) {
    try {
      const rawDb = getRawDatabase(deps.db);
      const result = await prefilterEntities(ctx.points, embeddingProvider, rawDb);
      effectiveRegistry = entityRegistry.filter((e) => result.candidateEntityIds.has(e.id));
      if (effectiveRegistry.length === 0) {
        effectiveRegistry = entityRegistry;
      }
      pointEmbeddingsCache = result.embeddingsCache;
      deps.logger?.info('[matching] Prefilter applied', {
        original: entityRegistry.length,
        filtered: effectiveRegistry.length,
        points: ctx.points.length,
      });
    } catch (err) {
      deps.logger?.warn('[matching] Prefilter failed, using full registry', {
        error: errorMessage(err),
      });
    }
  }

  const knowledgePoints = ctx.points.map((p) => ({
    pointKey: p.pointKey,
    type: p.type,
    content: p.content,
  }));

  const entities = effectiveRegistry.map((e) => {
    return {
      id: e.id,
      name: e.name,
      description: e.description ?? '',
      aliases: parseJsonStringArray(e.aliases).join(', '),
      categoryPath: e.categoryPaths[0] ?? '',
      keywords: parseJsonStringArray(e.keywords).join(', '),
    };
  });

  const classifierCategoryPath = ctx.classification?.categoryPath ?? '';
  const classifierKeywords = ctx.classification?.keywords ?? [];

  const language = ctx.config.language;
  const systemTemplate = loadPromptTemplate('matcher-system', language);
  const system = compilePrompt(systemTemplate, {});
  const rawTemplate = loadPromptTemplate('matcher', language);
  let prompt: string;
  try {
    prompt = compilePrompt(rawTemplate, {
      knowledgePoints,
      entities,
      hasEntities: entities.length > 0,
      classifierCategoryPath,
      classifierKeywords,
    });
  } catch (err) {
    throw new PipelineError(
      t('pipeline.matching.compilation_failed', {
        message: errorMessage(err),
      }),
      'matcher',
      'unknown',
      err,
    );
  }
  const promptHash = computePromptHash(rawTemplate, systemTemplate, language);

  let output: MatchingOutput;
  try {
    output = await deps.callLlm({
      step: 'matcher',
      schema: matchingSchema,
      system,
      prompt,
      promptHash,
      sourceId: ctx.source.id,
      llmCallRepo: deps.llmCallRepo,
      logPayloads: ctx.config.llmLogPayloads ?? false,
    });
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError(
      t('pipeline.matching.failed', { message: errorMessage(err) }),
      'matcher',
      'unknown',
      err,
    );
  }

  // Back-fill entityName for existing-entity references where the LLM may omit it.
  const registryMap = new Map(entityRegistry.map((e) => [e.id, e.name]));
  const backfilledEntities = output.entities.map((entity) => {
    if (entity.entityName) return entity;
    const match = entity.entityKey.match(/^entity:(\d+)$/);
    const name = match ? (registryMap.get(Number(match[1])) ?? entity.entityKey) : entity.entityKey;
    return { ...entity, entityName: name };
  });

  return {
    ...ctx,
    matchingOutput: { ...output, entities: backfilledEntities },
    entityRegistry,
    pointEmbeddingsCache,
  };
}
