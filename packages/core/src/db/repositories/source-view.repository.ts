import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../connection';
import { parseJsonNumberArray, parseJsonStringArray } from '../json-columns';
import {
  categories,
  entities,
  entityCategories,
  knowledgePoints,
  pointTags,
  sourceEntityPoints,
  sources,
  tags,
} from '../schema';
import type {
  SourceViewDetail,
  SourceViewEntityGroup,
  SourceViewListItem,
  SourceViewRepository,
  SourceViewStats,
} from './types';

export class SqliteSourceViewRepository implements SourceViewRepository {
  constructor(private db: DrizzleDB) {}

  listSourceViewWithCategories(): SourceViewListItem[] {
    const rows = this.db
      .select({
        id: sources.id,
        kind: sources.kind,
        title: sources.title,
        originalUrl: sources.originalUrl,
        createdAt: sources.createdAt,
        categoryIdsJson:
          sql<string>`COALESCE(json_group_array(DISTINCT CASE WHEN ${knowledgePoints.id} IS NOT NULL THEN ${entityCategories.categoryId} END), '[]')`.as(
            'category_ids_json',
          ),
      })
      .from(sources)
      .leftJoin(sourceEntityPoints, eq(sourceEntityPoints.sourceId, sources.id))
      .leftJoin(
        knowledgePoints,
        and(
          eq(knowledgePoints.id, sourceEntityPoints.pointId),
          eq(knowledgePoints.status, 'active'),
        ),
      )
      .leftJoin(entityCategories, eq(entityCategories.entityId, sourceEntityPoints.entityId))
      .where(inArray(sources.status, ['confirmed', 'confirmed_empty']))
      .groupBy(sources.id)
      .orderBy(desc(sources.createdAt), desc(sources.id))
      .all();

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as 'external' | 'user',
      title: r.title,
      originalUrl: r.originalUrl,
      createdAt: r.createdAt,
      categoryIds: [...new Set(parseJsonNumberArray(r.categoryIdsJson))],
    }));
  }

  getSourceViewDetail(sourceId: number): SourceViewDetail | undefined {
    const source = this.db
      .select()
      .from(sources)
      .where(
        and(eq(sources.id, sourceId), inArray(sources.status, ['confirmed', 'confirmed_empty'])),
      )
      .get();

    if (!source) return undefined;

    const rows = this.db
      .select({
        entityId: entities.id,
        entityName: entities.name,
        pointId: knowledgePoints.id,
        pointContent: knowledgePoints.content,
        pointContentTranslated: knowledgePoints.contentTranslated,
        pointType: knowledgePoints.type,
      })
      .from(sourceEntityPoints)
      .innerJoin(entities, eq(entities.id, sourceEntityPoints.entityId))
      .innerJoin(knowledgePoints, eq(knowledgePoints.id, sourceEntityPoints.pointId))
      .where(and(eq(sourceEntityPoints.sourceId, sourceId), eq(knowledgePoints.status, 'active')))
      .orderBy(entities.name, knowledgePoints.type, knowledgePoints.id)
      .all();

    const entityMap = new Map<number, SourceViewEntityGroup>();
    for (const row of rows) {
      let group = entityMap.get(row.entityId);
      if (!group) {
        group = { entityId: row.entityId, entityName: row.entityName, points: [] };
        entityMap.set(row.entityId, group);
      }
      group.points.push({
        id: row.pointId,
        content: row.pointContent,
        contentTranslated: row.pointContentTranslated,
        type: row.pointType,
      });
    }

    const categoryPathRows = this.db
      .selectDistinct({ path: categories.path })
      .from(sourceEntityPoints)
      .innerJoin(knowledgePoints, eq(knowledgePoints.id, sourceEntityPoints.pointId))
      .innerJoin(entityCategories, eq(entityCategories.entityId, sourceEntityPoints.entityId))
      .innerJoin(categories, eq(entityCategories.categoryId, categories.id))
      .where(and(eq(sourceEntityPoints.sourceId, sourceId), eq(knowledgePoints.status, 'active')))
      .all();

    return {
      source,
      entities: [...entityMap.values()],
      categoryPaths: categoryPathRows.map((r) => r.path),
    };
  }

  getSourceViewTags(sourceId: number): string[] {
    const collected = new Set<string>();

    // Entity-level tags: keywords and aliases of any entity linked to this
    // source through an active point. These are the LLM-extracted topical
    // labels that have been part of SourceViewDetail since the feature shipped.
    const entityRows = this.db
      .selectDistinct({
        keywords: entities.keywords,
        aliases: entities.aliases,
      })
      .from(sourceEntityPoints)
      .innerJoin(entities, eq(entities.id, sourceEntityPoints.entityId))
      .innerJoin(knowledgePoints, eq(knowledgePoints.id, sourceEntityPoints.pointId))
      .where(and(eq(sourceEntityPoints.sourceId, sourceId), eq(knowledgePoints.status, 'active')))
      .all();
    for (const row of entityRows) {
      for (const k of parseJsonStringArray(row.keywords)) collected.add(k);
      for (const a of parseJsonStringArray(row.aliases)) collected.add(a);
    }

    // Hashtag-style point tags: only opinion points carry these (storing.ts
    // filters them out for fact points). Joined through the same active-point
    // graph so a soft-deleted point's tags drop out of the note view.
    const pointTagRows = this.db
      .selectDistinct({ name: tags.name })
      .from(pointTags)
      .innerJoin(tags, eq(tags.id, pointTags.tagId))
      .innerJoin(knowledgePoints, eq(knowledgePoints.id, pointTags.pointId))
      .innerJoin(sourceEntityPoints, eq(sourceEntityPoints.pointId, knowledgePoints.id))
      .where(and(eq(sourceEntityPoints.sourceId, sourceId), eq(knowledgePoints.status, 'active')))
      .all();
    for (const row of pointTagRows) {
      if (row.name) collected.add(row.name);
    }

    return [...collected];
  }

  getSourceViewStats(): SourceViewStats {
    const row = this.db
      .select({
        sourceCount: sql<number>`COUNT(DISTINCT ${sources.id})`.as('source_count'),
        pointCount:
          sql<number>`COUNT(DISTINCT CASE WHEN ${knowledgePoints.status} = 'active' THEN ${knowledgePoints.id} END)`.as(
            'point_count',
          ),
      })
      .from(sources)
      .leftJoin(sourceEntityPoints, eq(sourceEntityPoints.sourceId, sources.id))
      .leftJoin(knowledgePoints, eq(knowledgePoints.id, sourceEntityPoints.pointId))
      .where(inArray(sources.status, ['confirmed', 'confirmed_empty']))
      .get();

    return {
      sourceCount: row?.sourceCount ?? 0,
      pointCount: row?.pointCount ?? 0,
    };
  }

  getRecentSourceViews(limit: number): SourceViewListItem[] {
    const rows = this.db
      .select({
        id: sources.id,
        kind: sources.kind,
        title: sources.title,
        originalUrl: sources.originalUrl,
        createdAt: sources.createdAt,
      })
      .from(sources)
      .where(inArray(sources.status, ['confirmed', 'confirmed_empty']))
      .orderBy(desc(sources.createdAt), desc(sources.id))
      .limit(limit)
      .all();

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as 'external' | 'user',
      title: r.title,
      originalUrl: r.originalUrl,
      createdAt: r.createdAt,
      categoryIds: [],
    }));
  }
}
