import type { ILogObj, Logger } from 'tslog';
import type {
  KnowledgePoint,
  KnowledgeRepository,
  LlmCallRepository,
} from '../../db/repositories/types';
import { errorMessage } from '../../errors';
import { t } from '../../i18n/index';
import { compilePrompt, computePromptHash, loadPromptTemplate } from '../../prompts/loader';
import {
  type CallLlmFn,
  comparingLlmSchema,
  determineOutputMode,
  type EntityJudgment,
  type IndexedPoint,
  newJudgment,
  type PipelineContext,
  PipelineError,
} from '../types';

export interface ComparingDeps {
  callLlm: CallLlmFn;
  llmCallRepo: LlmCallRepository;
  knowledgeRepo: KnowledgeRepository;
  logger?: Logger<ILogObj>;
}

export async function executeComparing(
  ctx: PipelineContext,
  deps: ComparingDeps,
): Promise<PipelineContext> {
  if (!ctx.matchingOutput) {
    throw new PipelineError(t('pipeline.comparing.no_matching_output'), 'comparing', 'unknown');
  }

  const entityJudgments: EntityJudgment[] = [];
  const pointMap = new Map(ctx.points.map((p) => [p.pointKey, p]));

  const language = ctx.config.language;
  const rawTemplate = loadPromptTemplate('comparator', language);
  const systemTemplate = loadPromptTemplate('comparator-system', language);
  const system = compilePrompt(systemTemplate, {});
  const promptHash = computePromptHash(rawTemplate, systemTemplate, language);

  const entityIdsToFetch: number[] = [];
  for (const entityMatch of ctx.matchingOutput.entities) {
    if (entityMatch.entityKey.startsWith('draft:')) continue;
    const match = entityMatch.entityKey.match(/^entity:(\d+)$/);
    if (match) entityIdsToFetch.push(Number(match[1]));
  }
  const existingFactPointsByEntity =
    entityIdsToFetch.length > 0
      ? deps.knowledgeRepo.getActiveFactPointsForEntities(entityIdsToFetch)
      : new Map<number, KnowledgePoint[]>();

  for (const entityMatch of ctx.matchingOutput.entities) {
    const isDraft = entityMatch.entityKey.startsWith('draft:');

    const entityPoints = entityMatch.knowledgePointKeys
      .map((key) => pointMap.get(key))
      .filter((p): p is IndexedPoint => p !== undefined);

    const factPoints = entityPoints.filter((p) => p.type === 'fact');
    const opinionPoints = entityPoints.filter((p) => p.type === 'opinion');

    let existingFactPoints: KnowledgePoint[] = [];
    if (!isDraft) {
      const match = entityMatch.entityKey.match(/^entity:(\d+)$/);
      if (!match) {
        deps.logger?.warn(
          `Skipping entity with invalid key format "${entityMatch.entityKey}", validate-output will handle cleanup`,
        );
        entityJudgments.push({
          entityKey: entityMatch.entityKey,
          entityName: entityMatch.entityName ?? entityMatch.entityKey,
          resolvedCategoryPath: entityMatch.resolvedCategoryPath,
          knowledgePointKeys: entityMatch.knowledgePointKeys,
          discoveredAliases: entityMatch.discoveredAliases,
          keywords: entityMatch.keywords,
          description: entityMatch.description,
          summary: undefined,
          outputMode: 'increment_only',
          pointJudgments: entityPoints.map((p) => newJudgment(p.pointKey)),
        });
        continue;
      }
      const entityId = Number(match[1]);
      existingFactPoints = existingFactPointsByEntity.get(entityId) ?? [];
    }

    const outputMode = determineOutputMode(
      existingFactPoints.length,
      ctx.config.outputFullThreshold,
      ctx.config.outputIncrementThreshold,
    );

    let factJudgments: EntityJudgment['pointJudgments'] = [];
    let summary: string | undefined;

    const needsLlmComparison = !isDraft && existingFactPoints.length > 0 && factPoints.length > 0;

    if (needsLlmComparison) {
      try {
        const prompt = compilePrompt(rawTemplate, {
          entityName: entityMatch.entityName,
          knowledgePoints: factPoints.map((p) => ({
            pointKey: p.pointKey,
            content: p.content,
          })),
          existingPoints: existingFactPoints.map((p) => ({
            id: p.id,
            content: p.content,
          })),
          hasExistingPoints: existingFactPoints.length > 0,
        });

        const llmOutput = await deps.callLlm({
          step: 'comparator',
          schema: comparingLlmSchema,
          system,
          prompt,
          promptHash,
          sourceId: ctx.source.id,
          llmCallRepo: deps.llmCallRepo,
          logPayloads: ctx.config.llmLogPayloads ?? false,
        });
        factJudgments = llmOutput.pointJudgments;
        summary = llmOutput.summary;
      } catch (err) {
        // Content policy and rate limit errors are non-transient or API-level —
        // re-throw to fail the pipeline so the user can retry later.
        // Rate limit: if one entity exhausts retries, subsequent entities will
        // almost certainly fail too, producing an entirely degraded result.
        if (
          err instanceof PipelineError &&
          (err.kind === 'content_policy' || err.kind === 'rate_limit')
        ) {
          throw err;
        }
        // Per-entity error isolation: degrade to treating all facts as new
        // so one entity failure doesn't discard all other entities' results.
        deps.logger?.warn(
          `Comparing failed for entity "${entityMatch.entityName ?? entityMatch.entityKey}", treating all points as new`,
          {
            err: errorMessage(err),
            stack: err instanceof Error ? err.stack : undefined,
            kind: err instanceof PipelineError ? err.kind : undefined,
          },
        );
        factJudgments = factPoints.map((p) => newJudgment(p.pointKey));
      }
    } else {
      factJudgments = factPoints.map((p) => newJudgment(p.pointKey));
    }

    const opinionJudgments = opinionPoints.map((p) => newJudgment(p.pointKey));

    const allJudgments = [...factJudgments, ...opinionJudgments];

    entityJudgments.push({
      entityKey: entityMatch.entityKey,
      entityName: entityMatch.entityName ?? entityMatch.entityKey,
      resolvedCategoryPath: entityMatch.resolvedCategoryPath,
      knowledgePointKeys: entityMatch.knowledgePointKeys,
      discoveredAliases: entityMatch.discoveredAliases,
      keywords: entityMatch.keywords,
      description: entityMatch.description,
      summary,
      outputMode,
      pointJudgments: allJudgments,
    });
  }

  return { ...ctx, entityJudgments };
}
