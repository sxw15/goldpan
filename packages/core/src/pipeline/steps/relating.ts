import type { LlmCallRepository } from '../../db/repositories/types';
import { errorMessage } from '../../errors';
import { t } from '../../i18n/index';
import { compilePrompt, computePromptHash, loadPromptTemplate } from '../../prompts/loader';
import type { RelatingOutput } from '../schemas/relator';
import {
  type CallLlmFn,
  type IndexedPoint,
  type PipelineContext,
  PipelineError,
  type RelationOutput,
  relatingSchema,
} from '../types';

export interface RelatingDeps {
  callLlm: CallLlmFn;
  llmCallRepo: LlmCallRepository;
}

export async function executeRelating(
  ctx: PipelineContext,
  deps: RelatingDeps,
): Promise<PipelineContext> {
  if (!ctx.config.relation.enabled) {
    return { ...ctx, relations: [] };
  }

  const entities = ctx.matchingOutput?.entities ?? [];
  if (entities.length < 2) {
    return { ...ctx, relations: [] };
  }

  const pointMap = new Map(ctx.points.map((p) => [p.pointKey, p]));
  const entityContext = entities.map((e) => ({
    entityKey: e.entityKey,
    entityName: e.entityName ?? e.entityKey,
    points: e.knowledgePointKeys
      .map((key) => pointMap.get(key))
      .filter((p): p is IndexedPoint => p != null)
      .map((p) => ({ pointKey: p.pointKey, content: p.content, type: p.type })),
  }));

  const language = ctx.config.language;
  const systemTemplate = loadPromptTemplate('relator-system', language);
  const userTemplate = loadPromptTemplate('relator', language);
  const system = compilePrompt(systemTemplate, {});
  let prompt: string;
  try {
    prompt = compilePrompt(userTemplate, { entities: entityContext });
  } catch (err) {
    throw new PipelineError(
      t('pipeline.relating.compilation_failed', {
        message: errorMessage(err),
      }),
      'relator',
      'unknown',
      err,
    );
  }
  const promptHash = computePromptHash(userTemplate, systemTemplate, language);

  let output: RelatingOutput;
  try {
    output = await deps.callLlm({
      step: 'relator',
      schema: relatingSchema,
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
      t('pipeline.relating.failed', {
        message: errorMessage(err),
      }),
      'relator',
      'unknown',
      err,
    );
  }

  const relations: RelationOutput[] = output.relations.map((r) => ({
    sourceEntityKey: r.sourceEntityKey,
    targetEntityKey: r.targetEntityKey,
    relationType: r.relationType,
    description: r.description,
  }));

  return { ...ctx, relations };
}
