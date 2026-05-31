import type { ILogObj, Logger } from 'tslog';
import { type DrizzleDB, getRawDatabase } from '../../db/connection';
import { parseJsonStringArray } from '../../db/json-columns';
import type {
  CategoryRepository,
  EventLogRepository,
  KnowledgeRepository,
  SourceRepository,
  SourceStatus,
  TaskRepository,
} from '../../db/repositories/types';
import { composeEntityText } from '../../db/vec';
import { errorMessage } from '../../errors';
import { t } from '../../i18n/index';
import {
  type DroppedPoint,
  type IndexedPoint,
  type PipelineContext,
  PipelineError,
  type ProcessingResult,
} from '../types';

export interface StoringDeps {
  db: DrizzleDB;
  categoryRepo: CategoryRepository;
  sourceRepo: SourceRepository;
  knowledgeRepo: KnowledgeRepository;
  taskRepo: TaskRepository;
  eventLogRepo: EventLogRepository;
  logger?: Logger<ILogObj>;
  embeddingProvider?: import('../../embedding/types').EmbeddingProvider | null;
}

export async function executeStoring(
  ctx: PipelineContext,
  deps: StoringDeps,
): Promise<PipelineContext> {
  const validEntities = ctx.validationResult?.validEntities ?? [];
  const droppedPoints = ctx.validationResult?.droppedPoints ?? [];
  const validationWarnings = [
    ...new Set([...(ctx.validationResult?.warnings ?? []), ...ctx.validationWarnings]),
  ];
  const verifierRejections = ctx.verifierRejections;
  const rejectedPointKeys = new Set(verifierRejections.map((r) => r.pointKey));
  const rejectionMap = new Map(verifierRejections.map((r) => [r.pointKey, r.reason]));
  const pointMap = new Map(ctx.points.map((p) => [p.pointKey, p]));
  const translations = ctx.translations ?? {};
  const tx = (id: string): string | undefined => {
    const v = translations[id];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };

  const existingEntityIds = validEntities
    .filter((ej) => !ej.entityKey.startsWith('draft:'))
    .map((ej) => Number(ej.entityKey.replace('entity:', '')))
    .filter((id) => Number.isFinite(id));
  const existingEntityById = new Map(
    existingEntityIds.length > 0
      ? deps.knowledgeRepo.getEntitiesByIds(existingEntityIds).map((e) => [e.id, e])
      : [],
  );

  const raw = getRawDatabase(deps.db);

  const result = raw
    .transaction(() => {
      const newPointMap = new Map<string, number>();
      let sepWritten = false;
      const entityResults: ProcessingResult['entities'] = [];
      const allMatchedPointIds: number[] = [];

      for (const ej of validEntities) {
        const isDraft = ej.entityKey.startsWith('draft:');
        let entityId: number;
        let isNew: boolean;

        const survivingJudgments = ej.pointJudgments.filter(
          (pj) => !(rejectedPointKeys.has(pj.pointKey) && pj.judgment === 'new'),
        );

        const newJudgments = survivingJudgments.filter((pj) => pj.judgment === 'new');
        const hasLivePoints = survivingJudgments.length > 0;

        if (isDraft) {
          if (newJudgments.length === 0) {
            // Still record rejected points for traceability
            // (spec: rejections must appear in entities[].rejectedPoints)
            const entityRejectedPoints = ej.pointJudgments
              .filter((pj) => rejectedPointKeys.has(pj.pointKey))
              .map((pj) => {
                const reason =
                  rejectionMap.get(pj.pointKey) ?? t('pipeline.storing.verifier_rejected');
                const reasonTranslated = tx(`vr:${pj.pointKey}`);
                return {
                  pointKey: pj.pointKey,
                  reason,
                  ...(reasonTranslated ? { reasonTranslated } : {}),
                };
              });
            if (entityRejectedPoints.length > 0) {
              const summaryTranslated = ej.summary ? tx(`s:${ej.entityKey}`) : undefined;
              entityResults.push({
                entityKey: ej.entityKey,
                entityId: undefined,
                entityName: ej.entityName,
                categoryPath: ej.resolvedCategoryPath,
                keywords: ej.keywords ?? [],
                isNew: true,
                outputMode: ej.outputMode,
                summary: ej.summary,
                ...(summaryTranslated ? { summaryTranslated } : {}),
                newFactPoints: [],
                newOpinionPoints: [],
                skippedFactCount: 0,
                skippedFactPoints: [],
                rejectedPoints: entityRejectedPoints,
              });
            }
            continue;
          }

          const categoryId = deps.categoryRepo.ensureCategoryPath(ej.resolvedCategoryPath);
          const entity = deps.knowledgeRepo.createEntity({
            name: ej.entityName,
            description: ej.description,
            descriptionTranslated: tx(`ed:${ej.entityKey}`),
            keywords: ej.keywords,
            aliases: [],
          });
          entityId = entity.id;
          isNew = true;

          deps.knowledgeRepo.linkEntityToCategory(entityId, categoryId);

          deps.eventLogRepo.create({
            sourceId: ctx.source.id,
            entityId,
            action: 'entity_created',
            summary: t('pipeline.storing.entity_created', { name: ej.entityName }),
          });

          if (ej.discoveredAliases?.length && hasLivePoints) {
            deps.knowledgeRepo.appendAliases(entityId, ej.discoveredAliases);

            deps.eventLogRepo.create({
              sourceId: ctx.source.id,
              entityId,
              action: 'entity_aliases_discovered',
              summary: t('pipeline.storing.aliases_discovered', {
                aliases: ej.discoveredAliases.join(', '),
              }),
            });
          }
        } else {
          const keyMatch = ej.entityKey.match(/^entity:(\d+)$/);
          if (!keyMatch) {
            throw new PipelineError(
              t('pipeline.storing.invalid_entity_key', { key: ej.entityKey }),
              'storing',
              'schema_validation',
            );
          }
          entityId = Number(keyMatch[1]);
          isNew = false;

          if (ej.discoveredAliases?.length && hasLivePoints) {
            deps.knowledgeRepo.appendAliases(entityId, ej.discoveredAliases);

            deps.eventLogRepo.create({
              sourceId: ctx.source.id,
              entityId,
              action: 'entity_aliases_discovered',
              summary: t('pipeline.storing.aliases_discovered', {
                aliases: ej.discoveredAliases.join(', '),
              }),
            });
          }
        }

        const newFactResults: ProcessingResult['entities'][0]['newFactPoints'] = [];
        const newOpinionResults: ProcessingResult['entities'][0]['newOpinionPoints'] = [];
        const skippedFactResults: ProcessingResult['entities'][0]['skippedFactPoints'] = [];

        for (const pj of survivingJudgments) {
          const point = pointMap.get(pj.pointKey);
          if (!point) {
            deps.logger?.warn(
              `[storing] pointKey "${pj.pointKey}" in survivingJudgments has no matching point — skipped`,
            );
            continue;
          }

          if (pj.judgment === 'new') {
            let pointId: number;
            const existingPointId = newPointMap.get(pj.pointKey);
            if (existingPointId !== undefined) {
              pointId = existingPointId;
            } else {
              const pointTranslated = tx(`p:${pj.pointKey}`);
              const created = deps.knowledgeRepo.createPoint(point.content, point.type, {
                contentTranslated: pointTranslated ?? null,
              });
              pointId = created.id;
              newPointMap.set(pj.pointKey, pointId);

              // Persist hashtag-style tags now (only opinion points carry them
              // — extracting filters fact-point tags out). Done at point
              // creation time so reruns of the same task don't double-link.
              if (point.type === 'opinion' && point.tags && point.tags.length > 0) {
                const upserted = deps.knowledgeRepo.upsertTags(point.tags);
                if (upserted.length > 0) {
                  deps.knowledgeRepo.linkPointTags(
                    pointId,
                    upserted.map((t) => t.id),
                  );
                }
              }

              deps.eventLogRepo.create({
                sourceId: ctx.source.id,
                entityId,
                pointId,
                action: 'point_created',
                summary: t(
                  point.type === 'fact'
                    ? 'pipeline.storing.point_created_fact'
                    : 'pipeline.storing.point_created_opinion',
                ),
              });
            }

            deps.knowledgeRepo.createSourceEntityPoint(ctx.source.id, entityId, pointId, 'new');
            sepWritten = true;

            const pointTranslated = tx(`p:${pj.pointKey}`);
            if (point.type === 'fact') {
              newFactResults.push({
                pointKey: pj.pointKey,
                pointId,
                content: point.content,
                ...(pointTranslated ? { contentTranslated: pointTranslated } : {}),
              });
            } else {
              newOpinionResults.push({
                pointKey: pj.pointKey,
                pointId,
                content: point.content,
                ...(pointTranslated ? { contentTranslated: pointTranslated } : {}),
                ...(point.tags && point.tags.length > 0 ? { tags: point.tags } : {}),
              });
            }
          } else {
            if (pj.matchedPointId == null) {
              throw new PipelineError(
                t('pipeline.storing.missing_matched_id', { pointKey: pj.pointKey }),
                'storing',
                'unknown',
              );
            }
            const matchedPointId = pj.matchedPointId;
            deps.knowledgeRepo.createSourceEntityPoint(
              ctx.source.id,
              entityId,
              matchedPointId,
              'skipped',
            );
            sepWritten = true;
            allMatchedPointIds.push(matchedPointId);

            if (point.type === 'fact') {
              skippedFactResults.push({
                pointKey: pj.pointKey,
                matchedPointId,
                matchedContent: pj.matchedContent ?? '',
              });
            }
          }
        }

        let entityKeywords: string[] = [];
        if (isNew && ej.keywords) {
          entityKeywords = ej.keywords;
        } else if (!isNew) {
          const existing = existingEntityById.get(entityId);
          if (existing) {
            entityKeywords = parseJsonStringArray(existing.keywords);
          }
        }

        const entityRejectedPoints = ej.pointJudgments
          .filter((pj) => rejectedPointKeys.has(pj.pointKey))
          .map((pj) => {
            const reason = rejectionMap.get(pj.pointKey) ?? t('pipeline.storing.verifier_rejected');
            const reasonTranslated = tx(`vr:${pj.pointKey}`);
            return {
              pointKey: pj.pointKey,
              reason,
              ...(reasonTranslated ? { reasonTranslated } : {}),
            };
          });

        const summaryTranslated = ej.summary ? tx(`s:${ej.entityKey}`) : undefined;
        const descriptionTranslated = isNew ? tx(`ed:${ej.entityKey}`) : undefined;
        entityResults.push({
          entityKey: ej.entityKey,
          entityId,
          entityName: ej.entityName,
          categoryPath: ej.resolvedCategoryPath,
          keywords: entityKeywords,
          isNew,
          outputMode: ej.outputMode,
          summary: ej.summary,
          ...(summaryTranslated ? { summaryTranslated } : {}),
          ...(descriptionTranslated ? { descriptionTranslated } : {}),
          newFactPoints: newFactResults,
          newOpinionPoints: newOpinionResults,
          skippedFactCount: skippedFactResults.length,
          skippedFactPoints: skippedFactResults,
          rejectedPoints: entityRejectedPoints.length > 0 ? entityRejectedPoints : undefined,
        });
      }

      // Build entityKey → real ID mapping for relation resolution
      const entityKeyToId = new Map<string, number>();
      for (const er of entityResults) {
        if (er.entityId != null) {
          entityKeyToId.set(er.entityKey, er.entityId);
        }
      }

      // Write relations
      let relationStoredCount = 0;
      let relationDedupCount = 0;

      if (ctx.validationResult?.validRelations?.length) {
        const insertRel = raw.prepare(`
          INSERT INTO entity_relations(source_entity_id, target_entity_id, relation_type, description, description_translated, source_id)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_entity_id, target_entity_id, relation_type) DO NOTHING
        `);

        for (const rel of ctx.validationResult.validRelations) {
          const sourceId = entityKeyToId.get(rel.sourceEntityKey);
          const targetId = entityKeyToId.get(rel.targetEntityKey);
          if (sourceId == null || targetId == null) continue;

          const relTranslated =
            tx(`r:${rel.sourceEntityKey}>${rel.targetEntityKey}:${rel.relationType}`) ?? null;
          const writeResult = insertRel.run(
            sourceId,
            targetId,
            rel.relationType,
            rel.description,
            relTranslated,
            ctx.source.id,
          );
          if (writeResult.changes > 0) relationStoredCount++;
          else relationDedupCount++;
        }
      }

      // Batch backfill matchedContent from DB
      if (allMatchedPointIds.length > 0) {
        const uniqueIds = [...new Set(allMatchedPointIds)];
        const dbPoints = deps.knowledgeRepo.getPointsByIds(uniqueIds);
        const dbPointMap = new Map(dbPoints.map((p) => [p.id, p.content]));

        for (const er of entityResults) {
          for (const sp of er.skippedFactPoints) {
            const dbContent = dbPointMap.get(sp.matchedPointId);
            if (dbContent) {
              sp.matchedContent = dbContent;
            }
          }
        }
      }

      const sourceStatus: SourceStatus =
        sepWritten || relationStoredCount > 0 ? 'confirmed' : 'confirmed_empty';
      deps.sourceRepo.updateStatus(ctx.source.id, sourceStatus, { emitTerminated: false });

      deps.eventLogRepo.create({
        sourceId: ctx.source.id,
        action: sourceStatus === 'confirmed' ? 'source_confirmed' : 'source_confirmed_empty',
        summary:
          sourceStatus === 'confirmed'
            ? t('pipeline.storing.source_confirmed')
            : t('pipeline.storing.source_confirmed_empty'),
      });

      const stats = calculateStats(ctx.points, entityResults, droppedPoints, verifierRejections);

      // Collect all accepted/skipped pointKeys from entity results
      const storedPointKeys = new Set<string>();
      for (const er of entityResults) {
        for (const p of er.newFactPoints) storedPointKeys.add(p.pointKey);
        for (const p of er.newOpinionPoints) storedPointKeys.add(p.pointKey);
        for (const p of er.skippedFactPoints) storedPointKeys.add(p.pointKey);
      }

      const dedupedDropped = [
        ...new Map(droppedPoints.map((dp) => [dp.pointKey, dp])).values(),
      ].filter((dp) => !storedPointKeys.has(dp.pointKey));

      const isOpinion = ctx.inputType === 'opinion';
      const processingResult: ProcessingResult = {
        taskId: String(ctx.task.id),
        status: 'done',
        inputMode: isOpinion ? 'opinion' : 'fact',
        // Surface the verbatim opinion so the NoteBubbleCard can render the
        // quote without an extra fetch. Only meaningful for user-typed input
        // (kind='user'); URL submissions never reach this branch as opinion.
        ...(isOpinion && ctx.source.rawContent ? { noteQuote: ctx.source.rawContent } : {}),
        stats,
        entities: entityResults,
        source: {
          id: ctx.source.id,
          title: ctx.source.title ?? '',
          originalUrl: ctx.source.originalUrl ?? undefined,
          kind: ctx.source.kind as 'external' | 'user',
        },
        classification: ctx.classification ?? undefined,
        droppedPoints: dedupedDropped.length > 0 ? dedupedDropped : undefined,
        validationWarnings: validationWarnings.length > 0 ? validationWarnings : undefined,
        relationStats: ctx.relations?.length
          ? {
              extracted: ctx.relations.length,
              validated: ctx.validationResult?.validRelations?.length ?? 0,
              stored: relationStoredCount,
              deduplicated: relationDedupCount,
            }
          : undefined,
      };

      deps.taskRepo.markDone(ctx.task.id, JSON.stringify(processingResult));

      return { processingResult, sourceStatus };
    })
    .immediate();
  deps.sourceRepo.emitTerminated(ctx.source.id, result.sourceStatus);
  const processingResult = result.processingResult;

  if (deps.embeddingProvider) {
    try {
      const entitiesToEmbed: Array<{ id: number; text: string }> = [];
      const pointsToEmbed: Array<{ id: number; text: string; pointKey: string }> = [];

      const embeddingEntityIds = processingResult.entities
        .map((er) => er.entityId)
        .filter((id): id is number => id != null);
      const entitiesById = new Map(
        deps.knowledgeRepo.getEntitiesByIds(embeddingEntityIds).map((e) => [e.id, e]),
      );

      for (const er of processingResult.entities) {
        if (!er.entityId) continue;
        const entity = entitiesById.get(er.entityId);
        if (entity) {
          entitiesToEmbed.push({
            id: er.entityId,
            text: composeEntityText({
              name: entity.name,
              description: entity.description,
              aliases: entity.aliases,
              keywords: entity.keywords,
            }),
          });
        }
        for (const p of er.newFactPoints) {
          if (p.pointId)
            pointsToEmbed.push({ id: p.pointId, text: p.content, pointKey: p.pointKey });
        }
        for (const p of er.newOpinionPoints) {
          if (p.pointId)
            pointsToEmbed.push({ id: p.pointId, text: p.content, pointKey: p.pointKey });
        }
      }

      const uniquePoints = [...new Map(pointsToEmbed.map((p) => [p.id, p])).values()];

      const cached: Array<{ id: number; embedding: number[] }> = [];
      const uncached: Array<{ id: number; text: string }> = [];

      for (const p of uniquePoints) {
        const cachedEmbedding = ctx.pointEmbeddingsCache?.get(p.pointKey);
        if (cachedEmbedding && cachedEmbedding.length === deps.embeddingProvider.dimensions) {
          cached.push({ id: p.id, embedding: cachedEmbedding });
        } else {
          uncached.push({ id: p.id, text: p.text });
        }
      }

      const entityEmbeddings =
        entitiesToEmbed.length > 0
          ? await deps.embeddingProvider.embedMany(entitiesToEmbed.map((e) => e.text))
          : [];

      const pointEmbeddings: number[][] = [];
      const pointIds: number[] = [];

      for (const c of cached) {
        pointEmbeddings.push(c.embedding);
        pointIds.push(c.id);
      }

      if (uncached.length > 0) {
        const freshEmbeddings = await deps.embeddingProvider.embedMany(uncached.map((p) => p.text));
        for (let i = 0; i < uncached.length; i++) {
          pointEmbeddings.push(freshEmbeddings[i]);
          pointIds.push(uncached[i].id);
        }
      }

      if (entityEmbeddings.length > 0 || pointEmbeddings.length > 0) {
        raw.transaction(() => {
          const delEntity = raw.prepare('DELETE FROM entities_vec WHERE rowid = ?');
          const insEntity = raw.prepare('INSERT INTO entities_vec(rowid, embedding) VALUES (?, ?)');
          for (let i = 0; i < entitiesToEmbed.length; i++) {
            delEntity.run(BigInt(entitiesToEmbed[i].id));
            insEntity.run(BigInt(entitiesToEmbed[i].id), new Float32Array(entityEmbeddings[i]));
          }

          const insPoint = raw.prepare(
            'INSERT INTO knowledge_points_vec(rowid, embedding) VALUES (?, ?)',
          );
          for (let i = 0; i < pointIds.length; i++) {
            insPoint.run(BigInt(pointIds[i]), new Float32Array(pointEmbeddings[i]));
          }
        })();
      }
    } catch (err) {
      deps.logger?.warn('[storing] Embedding write failed (non-fatal, backfill will retry)', {
        err: errorMessage(err),
      });
    }
  }

  return { ...ctx, processingResult };
}

function calculateStats(
  allPoints: IndexedPoint[],
  entityResults: ProcessingResult['entities'],
  droppedPoints: DroppedPoint[],
  verifierRejections: Array<{ pointKey: string }>,
): ProcessingResult['stats'] {
  const extracted = allPoints.length;
  const rejectedPointKeys = new Set(verifierRejections.map((r) => r.pointKey));

  const droppedByKey = new Map<string, DroppedPoint>();
  for (const dp of droppedPoints) {
    if (!droppedByKey.has(dp.pointKey)) {
      droppedByKey.set(dp.pointKey, dp);
    }
  }

  // Pre-build per-entity Sets for O(1) lookups instead of repeated .some()
  const entityNewKeys: Set<string>[] = [];
  const entitySkippedKeys: Set<string>[] = [];
  for (const er of entityResults) {
    const newKeys = new Set<string>();
    for (const p of er.newFactPoints) newKeys.add(p.pointKey);
    for (const p of er.newOpinionPoints) newKeys.add(p.pointKey);
    entityNewKeys.push(newKeys);
    entitySkippedKeys.push(new Set(er.skippedFactPoints.map((p) => p.pointKey)));
  }

  let accepted = 0;
  let droppedUnassigned = 0;
  let quarantined = 0;
  let skipped = 0;
  let verifierRejected = 0;

  for (const point of allPoints) {
    const key = point.pointKey;

    let hasNew = false;
    let hasSkipped = false;
    let assignedToAnyEntity = false;
    let notInAnyEntityResult = true;

    for (let idx = 0; idx < entityResults.length; idx++) {
      const isNew = entityNewKeys[idx].has(key);
      const isSkipped = entitySkippedKeys[idx].has(key);

      if (isNew || isSkipped) {
        assignedToAnyEntity = true;
        notInAnyEntityResult = false;
        if (isNew) hasNew = true;
        if (isSkipped) hasSkipped = true;
      }
    }

    const dp = droppedByKey.get(key);
    if (dp && (dp.reason === 'invalid_entity_ref' || dp.reason === 'invalid_entity_key_format')) {
      assignedToAnyEntity = true;
    }

    if (hasNew) {
      accepted++;
      continue;
    }
    if (hasSkipped) {
      skipped++;
      continue;
    }
    if (rejectedPointKeys.has(key)) {
      verifierRejected++;
      continue;
    }
    if (assignedToAnyEntity && notInAnyEntityResult) {
      quarantined++;
      continue;
    }
    if (!assignedToAnyEntity) {
      droppedUnassigned++;
      continue;
    }

    // Safety fallback — all branches above should be exhaustive.
    // If this line executes, a new classification was likely added without updating this logic.
    accepted++;
  }

  return { extracted, accepted, droppedUnassigned, quarantined, skipped, verifierRejected };
}
