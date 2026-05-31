import { type DrizzleDB, getRawDatabase } from '../../db/connection';
import type { KnowledgePoint, KnowledgeRepository } from '../../db/repositories/types';
import type { EmbeddingProvider } from '../../embedding/types';
import { t } from '../../i18n/index';
import { RELATION_TYPES } from '../schemas/relator';
import type {
  DroppedPoint,
  DroppedRelation,
  EntityJudgment,
  PipelineContext,
  RelationOutput,
} from '../types';
import { determineOutputMode, newJudgment } from '../types';

export interface ValidateOutputDeps {
  knowledgeRepo: KnowledgeRepository;
  embeddingProvider?: EmbeddingProvider | null;
  db?: DrizzleDB;
}

const ENTITY_KEY_PATTERN = /^entity:\d+$/;
const DRAFT_KEY_PATTERN = /^draft:.+$/;
const MAX_CATEGORY_DEPTH = 5;
const MAX_SEGMENT_LENGTH = 50;
const DRAFT_PROMOTION_DISTANCE_THRESHOLD = 0.3;

function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\u3400-\u4dbf]/g, '');
}

export async function validatePipelineOutput(
  ctx: PipelineContext,
  deps: ValidateOutputDeps,
): Promise<PipelineContext> {
  const warnings: string[] = [...ctx.validationWarnings];
  const droppedPoints: DroppedPoint[] = [];
  const pointMap = new Map(ctx.points.map((p) => [p.pointKey, p]));
  const validEntities: EntityJudgment[] = [];

  const entityRegistry = ctx.entityRegistry ?? deps.knowledgeRepo.getEntityRegistry();
  const existingByNormalizedName = new Map(entityRegistry.map((e) => [normalizeName(e.name), e]));
  const existingAliases = new Map<string, { entityId: number; entityName: string }>();
  for (const e of entityRegistry) {
    try {
      const parsed = JSON.parse(e.aliases);
      const aliases: string[] = Array.isArray(parsed)
        ? parsed.filter((a): a is string => typeof a === 'string')
        : [];
      for (const alias of aliases) {
        existingAliases.set(normalizeName(alias), {
          entityId: e.id,
          entityName: e.name,
        });
      }
    } catch {
      warnings.push(t('validation.alias_parse_failed', { id: e.id }));
    }
  }

  // Draft entity dedup
  const draftGroups = new Map<string, EntityJudgment>();
  const processedEntities: EntityJudgment[] = [];
  const draftKeyMap = new Map<string, string>();

  for (const ej of ctx.entityJudgments) {
    if (ej.entityKey.startsWith('draft:')) {
      const normalized = normalizeName(ej.entityName);

      const existingEntity = existingByNormalizedName.get(normalized);
      if (existingEntity) {
        warnings.push(
          t('validation.draft_name_match', {
            name: ej.entityName,
            entityId: existingEntity.id,
            entityName: existingEntity.name,
          }),
        );
        // M1: Warn that fact points were auto-judged 'new' without LLM comparison
        const factPoints = deps.knowledgeRepo.getActiveFactPointsForEntity(existingEntity.id);
        if (factPoints.length > 0) {
          warnings.push(
            t('validation.draft_downgrade_warning', {
              entityId: existingEntity.id,
              count: factPoints.length,
            }),
          );
        }
        // L9: Recalculate outputMode based on existing entity's active fact count
        const recalculatedOutputMode = determineOutputMode(
          factPoints.length,
          ctx.config.outputFullThreshold,
          ctx.config.outputIncrementThreshold,
        );
        processedEntities.push({
          ...ej,
          entityKey: `entity:${existingEntity.id}`,
          entityName: existingEntity.name,
          outputMode: recalculatedOutputMode,
        });
        draftKeyMap.set(ej.entityKey, `entity:${existingEntity.id}`);
        continue;
      }

      const aliasMatch = existingAliases.get(normalized);
      if (aliasMatch) {
        warnings.push(
          t('validation.draft_alias_match', {
            name: ej.entityName,
            entityName: aliasMatch.entityName,
          }),
        );
      }

      const existing = draftGroups.get(normalized);
      if (existing) {
        warnings.push(
          t('validation.draft_dedup', { name: ej.entityName, target: existing.entityName }),
        );
        existing.knowledgePointKeys = [
          ...new Set([...existing.knowledgePointKeys, ...ej.knowledgePointKeys]),
        ];
        // Merge pointJudgments with Map-based dedup (same logic as entity ref merge)
        const existingKeys = new Map(existing.pointJudgments.map((pj) => [pj.pointKey, pj]));
        for (const pj of ej.pointJudgments) {
          if (!existingKeys.has(pj.pointKey)) {
            existingKeys.set(pj.pointKey, pj);
          }
        }
        existing.pointJudgments = [...existingKeys.values()];
        // Merge discoveredAliases (deduplicated)
        if (ej.discoveredAliases?.length) {
          existing.discoveredAliases = [
            ...new Set([...(existing.discoveredAliases ?? []), ...ej.discoveredAliases]),
          ];
        }
        // Merge keywords (deduplicated), keeping existing first
        if (ej.keywords?.length) {
          existing.keywords = [...new Set([...(existing.keywords ?? []), ...ej.keywords])];
        }
        // Keep longest description / summary (prefer more detail)
        if (
          ej.description &&
          (!existing.description || ej.description.length > existing.description.length)
        ) {
          existing.description = ej.description;
        }
        if (ej.summary && (!existing.summary || ej.summary.length > existing.summary.length)) {
          existing.summary = ej.summary;
        }
        draftKeyMap.set(ej.entityKey, existing.entityKey);
        continue;
      }

      draftGroups.set(normalized, { ...ej });
    } else {
      processedEntities.push(ej);
    }
  }

  processedEntities.push(...draftGroups.values());

  if (deps.embeddingProvider && deps.db) {
    const rawDb = getRawDatabase(deps.db);
    const unpromoted = processedEntities.filter((ej) => ej.entityKey.startsWith('draft:'));

    if (unpromoted.length > 0) {
      try {
        const texts = unpromoted.map((d) => {
          const parts = [d.entityName];
          if (d.description) parts.push(d.description);
          if (d.discoveredAliases?.length) {
            parts.push(`Aliases: ${d.discoveredAliases.join(', ')}`);
          }
          if (d.keywords?.length) {
            parts.push(`Keywords: ${d.keywords.join(', ')}`);
          }
          return parts.join('. ');
        });
        const embeddings = await deps.embeddingProvider.embedMany(texts);

        const stmt = rawDb.prepare(
          'SELECT rowid, distance FROM entities_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 1',
        );

        for (let i = 0; i < unpromoted.length; i++) {
          const draft = unpromoted[i];
          const rows = stmt.all(new Float32Array(embeddings[i])) as Array<{
            rowid: number;
            distance: number;
          }>;

          if (rows.length > 0 && rows[0].distance < DRAFT_PROMOTION_DISTANCE_THRESHOLD) {
            const matchedEntity = entityRegistry.find((e) => e.id === rows[0].rowid);
            if (matchedEntity) {
              warnings.push(
                `Draft "${draft.entityName}" promoted to entity:${matchedEntity.id} ` +
                  `"${matchedEntity.name}" via embedding similarity ` +
                  `(distance=${rows[0].distance.toFixed(4)})`,
              );
              const factPoints = deps.knowledgeRepo.getActiveFactPointsForEntity(matchedEntity.id);
              if (factPoints.length > 0) {
                warnings.push(
                  t('validation.draft_downgrade_warning', {
                    entityId: matchedEntity.id,
                    count: factPoints.length,
                  }),
                );
              }
              const recalculatedOutputMode = determineOutputMode(
                factPoints.length,
                ctx.config.outputFullThreshold,
                ctx.config.outputIncrementThreshold,
              );
              const originalDraftKey = draft.entityKey;
              draft.entityKey = `entity:${matchedEntity.id}`;
              draft.entityName = matchedEntity.name;
              draft.outputMode = recalculatedOutputMode;
              draftKeyMap.set(originalDraftKey, draft.entityKey);
            }
          }
        }
      } catch {
        // embedding fallback failure does not block pipeline
      }
    }
  }

  // Resolve transitive draft key mappings (loser→winner→entity:N)
  for (const [key, value] of draftKeyMap) {
    let resolved = value;
    while (draftKeyMap.has(resolved) && draftKeyMap.get(resolved) !== resolved) {
      resolved = draftKeyMap.get(resolved) ?? resolved;
    }
    if (resolved !== value) draftKeyMap.set(key, resolved);
  }

  // Merge duplicate entity:N references
  const entityRefGroups = new Map<string, EntityJudgment>();
  const mergedEntities: EntityJudgment[] = [];

  for (const ej of processedEntities) {
    if (ENTITY_KEY_PATTERN.test(ej.entityKey)) {
      const existing = entityRefGroups.get(ej.entityKey);
      if (existing) {
        warnings.push(t('validation.entity_ref_dedup', { name: ej.entityName, key: ej.entityKey }));
        existing.knowledgePointKeys = [
          ...new Set([...existing.knowledgePointKeys, ...ej.knowledgePointKeys]),
        ];
        // Merge discoveredAliases (deduplicated)
        if (ej.discoveredAliases?.length) {
          existing.discoveredAliases = [
            ...new Set([...(existing.discoveredAliases ?? []), ...ej.discoveredAliases]),
          ];
        }
        // Merge pointJudgments: for duplicate pointKeys, prefer 'skipped' (with valid matchedPointId) over 'new'
        const existingKeys = new Map(existing.pointJudgments.map((pj) => [pj.pointKey, pj]));
        for (const pj of ej.pointJudgments) {
          const prev = existingKeys.get(pj.pointKey);
          if (prev) {
            // Prefer skipped with matchedPointId over new
            if (
              pj.judgment === 'skipped' &&
              pj.matchedPointId !== null &&
              prev.judgment === 'new'
            ) {
              existingKeys.set(pj.pointKey, pj);
            }
            // Otherwise keep previous (first wins for same judgment)
          } else {
            existingKeys.set(pj.pointKey, pj);
          }
        }
        existing.pointJudgments = [...existingKeys.values()];
        continue;
      }
      entityRefGroups.set(ej.entityKey, { ...ej });
    } else {
      mergedEntities.push(ej);
    }
  }
  mergedEntities.push(...entityRefGroups.values());

  const entityRefIds: number[] = [];
  for (const ej of mergedEntities) {
    if (!ENTITY_KEY_PATTERN.test(ej.entityKey)) continue;
    const id = Number(ej.entityKey.replace('entity:', ''));
    if (Number.isFinite(id)) entityRefIds.push(id);
  }
  const factPointsByEntity: Map<number, KnowledgePoint[]> =
    entityRefIds.length > 0
      ? deps.knowledgeRepo.getActiveFactPointsForEntities(entityRefIds)
      : new Map();

  // Per-entity validation
  for (const ej of mergedEntities) {
    const isEntityRef = ENTITY_KEY_PATTERN.test(ej.entityKey);
    const isDraft = DRAFT_KEY_PATTERN.test(ej.entityKey);

    if (!isEntityRef && !isDraft) {
      for (const key of ej.knowledgePointKeys) {
        const point = pointMap.get(key);
        if (point) {
          droppedPoints.push({
            pointKey: key,
            entityKey: ej.entityKey,
            content: point.content,
            type: point.type,
            reason: 'invalid_entity_key_format',
          });
        }
      }
      continue;
    }

    if (isEntityRef) {
      const entityId = Number(ej.entityKey.replace('entity:', ''));
      const entity = deps.knowledgeRepo.getEntityById(entityId);
      if (!entity) {
        for (const key of ej.knowledgePointKeys) {
          const point = pointMap.get(key);
          if (point) {
            droppedPoints.push({
              pointKey: key,
              entityKey: ej.entityKey,
              content: point.content,
              type: point.type,
              reason: 'invalid_entity_ref',
            });
          }
        }
        continue;
      }
    }

    // Validate and rebuild pointJudgments
    const validJudgments: EntityJudgment['pointJudgments'] = [];
    const seenPointKeys = new Set<string>();

    let existingPointIds = new Set<number>();
    if (isEntityRef) {
      const entityId = Number(ej.entityKey.replace('entity:', ''));
      const existingPoints = factPointsByEntity.get(entityId) ?? [];
      existingPointIds = new Set(existingPoints.map((p) => p.id));
    }

    // Pass 1: Validate point judgments.
    // Opinion points are handled here as always-'new' (lines below); Pass 2 catches any
    // remaining opinions from knowledgePointKeys not present in pointJudgments.
    for (const pj of ej.pointJudgments) {
      if (!pointMap.has(pj.pointKey)) {
        warnings.push(t('validation.unknown_point_key', { key: pj.pointKey }));
        continue;
      }

      if (seenPointKeys.has(pj.pointKey)) {
        warnings.push(t('validation.duplicate_point_key', { key: pj.pointKey }));
        continue;
      }

      const point = pointMap.get(pj.pointKey);
      if (!point) continue;

      if (point.type === 'opinion') {
        seenPointKeys.add(pj.pointKey);
        validJudgments.push(newJudgment(pj.pointKey));
        continue;
      }

      seenPointKeys.add(pj.pointKey);

      if (pj.judgment === 'skipped' && pj.matchedPointId !== null) {
        if (!existingPointIds.has(pj.matchedPointId)) {
          warnings.push(t('validation.invalid_matched_id', { id: pj.matchedPointId }));
          validJudgments.push(newJudgment(pj.pointKey));
          continue;
        }
      }

      if (pj.judgment === 'skipped' && pj.matchedPointId === null) {
        warnings.push(t('validation.skipped_null_matched', { key: pj.pointKey }));
        validJudgments.push(newJudgment(pj.pointKey));
        continue;
      }

      validJudgments.push(pj);
    }

    // Fill in missing fact points
    for (const key of ej.knowledgePointKeys) {
      const point = pointMap.get(key);
      if (!point) continue;
      if (point.type === 'fact' && !seenPointKeys.has(key)) {
        validJudgments.push(newJudgment(key));
        seenPointKeys.add(key);
      }
    }

    // Pass 2: Add opinion points (always 'new', no matchedPointId validation needed).
    // Use seenPointKeys to prevent duplicates if LLM returns the same key twice.
    for (const key of ej.knowledgePointKeys) {
      if (seenPointKeys.has(key)) continue;
      const point = pointMap.get(key);
      if (!point) continue;
      if (point.type === 'opinion') {
        seenPointKeys.add(key);
        validJudgments.push(newJudgment(key));
      }
    }

    // Category path validation (draft entities only)
    let resolvedPath = ej.resolvedCategoryPath;
    if (isDraft) {
      resolvedPath = validateCategoryPath(
        resolvedPath,
        ctx.classification?.categoryPath ?? 'Uncategorized',
        warnings,
      );
    }

    validEntities.push({
      ...ej,
      resolvedCategoryPath: resolvedPath,
      pointJudgments: validJudgments,
    });
  }

  // Unassigned points
  const assignedPointKeys = new Set<string>();
  for (const ej of validEntities) {
    for (const key of ej.knowledgePointKeys) {
      assignedPointKeys.add(key);
    }
  }
  for (const dp of droppedPoints) {
    assignedPointKeys.add(dp.pointKey);
  }

  for (const point of ctx.points) {
    if (!assignedPointKeys.has(point.pointKey)) {
      droppedPoints.push({
        pointKey: point.pointKey,
        content: point.content,
        type: point.type,
        reason: 'unassigned',
      });
    }
  }

  // Relation validation
  const validEntityKeys = new Set(validEntities.map((e) => e.entityKey));
  const validRelations: RelationOutput[] = [];
  const droppedRelations: DroppedRelation[] = [];
  const relationDedup = new Set<string>();

  for (const rel of ctx.relations ?? []) {
    let { sourceEntityKey, targetEntityKey } = rel;
    const { relationType, description } = rel;

    // Apply draft promotion mapping
    sourceEntityKey = draftKeyMap.get(sourceEntityKey) ?? sourceEntityKey;
    targetEntityKey = draftKeyMap.get(targetEntityKey) ?? targetEntityKey;

    // Validate entityKeys exist in final valid set
    if (!validEntityKeys.has(sourceEntityKey) || !validEntityKeys.has(targetEntityKey)) {
      droppedRelations.push({
        sourceEntityKey,
        targetEntityKey,
        relationType,
        reason: 'invalid_entity_ref',
      });
      warnings.push(
        t('validation.relation_invalid_ref', { source: sourceEntityKey, target: targetEntityKey }),
      );
      continue;
    }

    // Self-reference check (can happen after draft promotion)
    if (sourceEntityKey === targetEntityKey) {
      droppedRelations.push({
        sourceEntityKey,
        targetEntityKey,
        relationType,
        reason: 'self_reference',
      });
      warnings.push(t('validation.relation_self_ref', { key: sourceEntityKey }));
      continue;
    }

    // Type validation
    if (!(RELATION_TYPES as readonly string[]).includes(relationType)) {
      droppedRelations.push({
        sourceEntityKey,
        targetEntityKey,
        relationType,
        reason: 'invalid_type',
      });
      warnings.push(t('validation.relation_invalid_type', { type: relationType }));
      continue;
    }

    // Post-promotion dedup
    const dedupKey = `${sourceEntityKey}|${targetEntityKey}|${relationType}`;
    if (relationDedup.has(dedupKey)) {
      droppedRelations.push({
        sourceEntityKey,
        targetEntityKey,
        relationType,
        reason: 'duplicate_after_promotion',
      });
      warnings.push(
        t('validation.relation_dedup', {
          source: sourceEntityKey,
          target: targetEntityKey,
          type: relationType,
        }),
      );
      continue;
    }
    relationDedup.add(dedupKey);

    validRelations.push({ sourceEntityKey, targetEntityKey, relationType, description });
  }

  return {
    ...ctx,
    validationResult: { validEntities, droppedPoints, warnings, validRelations, droppedRelations },
    validationWarnings: warnings,
  };
}

function validateCategoryPath(path: string, fallbackPath: string, warnings: string[]): string {
  if (!path || path.trim().length === 0) {
    warnings.push(t('validation.category_empty', { fallback: fallbackPath }));
    return fallbackPath;
  }

  let segments = path
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (segments.length > MAX_CATEGORY_DEPTH) {
    warnings.push(
      t('validation.category_depth_exceeded', {
        depth: segments.length,
        limit: MAX_CATEGORY_DEPTH,
      }),
    );
    segments = segments.slice(0, MAX_CATEGORY_DEPTH);
  }

  segments = segments.map((s) => {
    if (s.length > MAX_SEGMENT_LENGTH) {
      warnings.push(
        t('validation.category_segment_long', {
          segment: s.substring(0, 20),
          limit: MAX_SEGMENT_LENGTH,
        }),
      );
      return s.substring(0, MAX_SEGMENT_LENGTH);
    }
    return s;
  });

  if (segments.length === 0) {
    warnings.push(t('validation.category_empty_after_norm', { fallback: fallbackPath }));
    return fallbackPath;
  }

  return segments.join('/');
}
