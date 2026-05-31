import type { ILogObj, Logger } from 'tslog';
import type { DrizzleDB } from '../db/connection';
import { getRawDatabase } from '../db/connection';
import { errorMessage } from '../errors';
import type { SearchResult } from './search';

const MAX_EXPANDED_ENTITIES = 10;
const MAX_POINTS_PER_EXPANDED = 5;

interface RelationRow {
  id: number;
  source_entity_id: number;
  target_entity_id: number;
  relation_type: string;
  description: string;
  source_name: string;
  target_name: string;
}

export interface ExpandWithRelationsOptions {
  logger?: Logger<ILogObj>;
}

export interface ExpandWithRelationsResult {
  relationsContext: string;
  /** Includes relation-expanded entities; the input `searchResults` is not mutated. */
  searchResults: SearchResult;
}

function cloneSearchResult(searchResults: SearchResult): SearchResult {
  return { entities: [...searchResults.entities] };
}

function isMissingTable(err: unknown): boolean {
  const msg = errorMessage(err);
  return /no such table/i.test(msg);
}

function logUnexpectedExpandError(
  err: unknown,
  options: ExpandWithRelationsOptions | undefined,
): void {
  const detail = errorMessage(err);
  if (options?.logger) {
    options.logger.warn('expandWithRelations failed', { error: detail });
  } else {
    console.warn('[goldpan] expandWithRelations:', detail);
  }
}

export function expandWithRelations(
  searchResults: SearchResult,
  db: DrizzleDB,
  options?: ExpandWithRelationsOptions,
): ExpandWithRelationsResult {
  const empty = (): ExpandWithRelationsResult => ({
    relationsContext: '',
    searchResults: cloneSearchResult(searchResults),
  });

  if (searchResults.entities.length < 1) {
    return empty();
  }

  try {
    const raw = getRawDatabase(db);
    const entityIds = searchResults.entities.map((e) => e.id);
    const entityIdSet = new Set(entityIds);
    const placeholders = entityIds.map(() => '?').join(',');
    const relations = raw
      .prepare(`
      SELECT er.id, er.source_entity_id, er.target_entity_id,
             er.relation_type, er.description,
             se.name AS source_name, te.name AS target_name
      FROM entity_relations er
      JOIN entities se ON se.id = er.source_entity_id
      JOIN entities te ON te.id = er.target_entity_id
      WHERE er.source_entity_id IN (${placeholders})
         OR er.target_entity_id IN (${placeholders})
      ORDER BY er.created_at DESC
      LIMIT 50
    `)
      .all(...entityIds, ...entityIds) as RelationRow[];

    const entities = [...searchResults.entities];

    if (relations.length === 0) {
      return { relationsContext: '', searchResults: { entities } };
    }

    const missingEntityIds = new Set<number>();
    for (const rel of relations) {
      if (!entityIdSet.has(rel.source_entity_id)) {
        missingEntityIds.add(rel.source_entity_id);
      }
      if (!entityIdSet.has(rel.target_entity_id)) {
        missingEntityIds.add(rel.target_entity_id);
      }
    }

    if (missingEntityIds.size > 0) {
      const missingIds = [...missingEntityIds].slice(0, MAX_EXPANDED_ENTITIES);
      const ph = missingIds.map(() => '?').join(',');

      const entityRows = raw
        .prepare(`SELECT id, name, description FROM entities WHERE id IN (${ph})`)
        .all(...missingIds) as Array<{ id: number; name: string; description: string | null }>;

      const pointRows = raw
        .prepare(`
        SELECT DISTINCT sep.entity_id, kp.id, kp.content, kp.type
        FROM source_entity_points sep
        JOIN knowledge_points kp ON kp.id = sep.point_id
        WHERE sep.entity_id IN (${ph}) AND kp.status = 'active'
        ORDER BY kp.id DESC
      `)
        .all(...missingIds) as Array<{
        entity_id: number;
        id: number;
        content: string;
        type: string;
      }>;

      const pointMap = new Map<number, Array<{ id: number; content: string; type: string }>>();
      for (const row of pointRows) {
        const list = pointMap.get(row.entity_id) ?? [];
        if (list.length < MAX_POINTS_PER_EXPANDED) {
          list.push({ id: row.id, content: row.content, type: row.type });
          pointMap.set(row.entity_id, list);
        }
      }

      for (const entity of entityRows) {
        entities.push({
          id: entity.id,
          name: entity.name,
          description: entity.description,
          aliases: [],
          keywords: [],
          categoryPaths: [],
          lastSourceDate: null,
          points: (pointMap.get(entity.id) ?? []).map((p) => ({
            id: p.id,
            content: p.content,
            type: p.type as 'fact' | 'opinion',
          })),
          matchedBy: ['relation'],
        });
      }
    }

    const lines = relations.map(
      (r) => `- ${r.source_name} → ${r.target_name}: ${r.relation_type} — ${r.description}`,
    );
    return { relationsContext: lines.join('\n'), searchResults: { entities } };
  } catch (err) {
    if (isMissingTable(err)) {
      return empty();
    }
    logUnexpectedExpandError(err, options);
    return empty();
  }
}
