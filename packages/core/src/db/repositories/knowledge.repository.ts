import { and, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { normalizeTags } from '../../utils/tag-normalize';
import type { DrizzleDB } from '../connection';
import { getRawDatabase } from '../connection';
import { parseJsonStringArray } from '../json-columns';
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
import { utcNowMs } from '../timestamp';
import type {
  CreateEntityInput,
  CreatePointOptions,
  Entity,
  EntityRelation,
  EntityRelationType,
  FindRecentRelationsInput,
  Judgment,
  KnowledgePoint,
  KnowledgeRepository,
  PointType,
  RecentRelationRow,
  Source,
} from './types';

export class SqliteKnowledgeRepository implements KnowledgeRepository {
  constructor(private db: DrizzleDB) {}

  createEntity(input: CreateEntityInput): Entity {
    const [ent] = this.db
      .insert(entities)
      .values({
        name: input.name,
        description: input.description ?? null,
        descriptionTranslated: input.descriptionTranslated ?? null,
        aliases: JSON.stringify(input.aliases ?? []),
        keywords: JSON.stringify(input.keywords ?? []),
      })
      .returning()
      .all();
    return ent;
  }

  getEntityById(id: number): Entity | undefined {
    return this.db.select().from(entities).where(eq(entities.id, id)).get();
  }

  /**
   * Look up entities by name (case-insensitive). Returns matching entities
   * with `{id, name}` only. Empty input → empty array (no SQL trip).
   * Used by P7.3 mention parsing to resolve @name tokens to entity ids.
   */
  findEntitiesByNames(names: string[]): Array<{ id: number; name: string }> {
    if (names.length === 0) return [];
    const lowered = Array.from(new Set(names.map((n) => n.toLowerCase())));
    return this.db
      .select({ id: entities.id, name: entities.name })
      .from(entities)
      .where(inArray(sql`LOWER(${entities.name})`, lowered))
      .all();
  }

  /**
   * Returns entities that have at least one active knowledge point.
   * Entities with zero active points are intentionally excluded — the pipeline's
   * matching/comparing steps only need entities with active knowledge.
   * This means newly-created entities with no points yet will not appear here.
   */
  getEntityRegistry(): Array<Entity & { categoryPaths: string[]; activePointCount: number }> {
    const rows = this.db
      .select({
        id: entities.id,
        name: entities.name,
        description: entities.description,
        descriptionTranslated: entities.descriptionTranslated,
        aliases: entities.aliases,
        keywords: entities.keywords,
        createdAt: entities.createdAt,
        updatedAt: entities.updatedAt,
        categoryPathsJson: sql<string>`json_group_array(DISTINCT ${categories.path})`.as(
          'category_paths_json',
        ),
        activePointCount: sql<number>`COUNT(DISTINCT ${knowledgePoints.id})`.as(
          'active_point_count',
        ),
      })
      .from(entities)
      .innerJoin(sourceEntityPoints, eq(entities.id, sourceEntityPoints.entityId))
      .innerJoin(
        knowledgePoints,
        and(
          eq(sourceEntityPoints.pointId, knowledgePoints.id),
          eq(knowledgePoints.status, 'active'),
        ),
      )
      .leftJoin(entityCategories, eq(entities.id, entityCategories.entityId))
      .leftJoin(categories, eq(entityCategories.categoryId, categories.id))
      .groupBy(entities.id)
      .orderBy(entities.name)
      .all();

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      descriptionTranslated: r.descriptionTranslated,
      aliases: r.aliases,
      keywords: r.keywords,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      categoryPaths: parseJsonStringArray(r.categoryPathsJson),
      activePointCount: r.activePointCount,
    }));
  }

  /** Append aliases to an entity, filtering out conflicts with other entities.
   *  IMPORTANT: Caller must ensure this runs inside a transaction to prevent TOCTOU races. */
  appendAliases(entityId: number, newAliases: string[]): void {
    const ent = this.getEntityById(entityId);
    if (!ent) return;
    const existing = parseJsonStringArray(ent.aliases);

    const filtered = newAliases.filter((alias) => {
      const aliasLower = alias.toLowerCase();
      if (existing.some((e) => e.toLowerCase() === aliasLower)) return false;
      const nameConflict = this.db
        .select({ id: entities.id })
        .from(entities)
        .where(
          and(sql`LOWER(${entities.name}) = LOWER(${alias})`, sql`${entities.id} != ${entityId}`),
        )
        .get();
      if (nameConflict) return false;
      try {
        const conflict = this.db.all(
          sql`SELECT ${entities.id} FROM ${entities}, json_each(${entities.aliases})
              WHERE LOWER(json_each.value) = LOWER(${alias})
              AND ${entities.id} != ${entityId} LIMIT 1`,
        ) as Array<{ id: number }>;
        if (conflict.length > 0) return false;
      } catch {
        return false;
      }
      return true;
    });

    if (filtered.length === 0) return;
    const merged = [...new Set([...existing, ...filtered])];
    this.db
      .update(entities)
      .set({ aliases: JSON.stringify(merged), updatedAt: utcNowMs() })
      .where(eq(entities.id, entityId))
      .run();
  }

  linkEntityToCategory(entityId: number, categoryId: number): void {
    this.db
      .insert(entityCategories)
      .values({ entityId, categoryId })
      .onConflictDoNothing({ target: [entityCategories.entityId, entityCategories.categoryId] })
      .run();
  }

  createPoint(content: string, type: PointType, options?: CreatePointOptions): KnowledgePoint {
    const [point] = this.db
      .insert(knowledgePoints)
      .values({ content, type, contentTranslated: options?.contentTranslated ?? null })
      .returning()
      .all();
    return point;
  }

  /**
   * Upsert hashtag-style tag rows. Uniqueness is **case-insensitive on the
   * trimmed name**: `"React"`, `" react "`, and `"REACT"` all collapse to a
   * single row, with the first-seen casing kept as the persisted display
   * value. Returns the persisted rows in the same order as the (deduped)
   * inputs so callers can link them deterministically.
   *
   * The DB unique index on `tags.name` is case-sensitive (last-resort guard),
   * so this method does the case-fold dedupe itself by querying with
   * `lower(name) IN (...)` against existing rows before deciding what to
   * insert — without that, two consecutive submissions of `"React"` and
   * `"react"` would each pass the in-memory dedupe inside their own call but
   * produce two distinct DB rows.
   */
  upsertTags(names: string[]): Array<{ id: number; name: string }> {
    const canonicalDisplays = normalizeTags(names);
    if (canonicalDisplays.length === 0) return [];
    const canonicalKeys = canonicalDisplays.map((n) => n.toLowerCase());

    // Match existing rows by case-folded name. `inArray(lower(name), keys)`
    // — the DB index is case-sensitive but the comparison here is not, so a
    // prior "React" row matches the incoming "react" key.
    const existing = this.db
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(inArray(sql`lower(${tags.name})`, canonicalKeys))
      .all();
    const existingByKey = new Map(existing.map((r) => [r.name.toLowerCase(), r]));

    const toInsert: Array<{ key: string; display: string }> = [];
    for (let i = 0; i < canonicalKeys.length; i++) {
      const key = canonicalKeys[i];
      if (!existingByKey.has(key)) {
        toInsert.push({ key, display: canonicalDisplays[i] });
      }
    }

    let insertedByKey = new Map<string, { id: number; name: string }>();
    if (toInsert.length > 0) {
      const inserted = this.db
        .insert(tags)
        .values(toInsert.map((t) => ({ name: t.display })))
        .returning()
        .all();
      insertedByKey = new Map(inserted.map((r) => [r.name.toLowerCase(), r]));
    }

    return canonicalKeys.map((key, i) => {
      const row = existingByKey.get(key) ?? insertedByKey.get(key);
      if (!row) {
        // Should be unreachable: each key is either already in DB or we just
        // inserted it. Throw rather than silently dropping to surface any
        // future invariant break loudly.
        throw new Error(
          `upsertTags: tag not resolved after insert (key=${key}, display=${canonicalDisplays[i]})`,
        );
      }
      return { id: row.id, name: row.name };
    });
  }

  linkPointTags(pointId: number, tagIds: number[]): void {
    if (tagIds.length === 0) return;
    this.db
      .insert(pointTags)
      .values(tagIds.map((tagId) => ({ pointId, tagId })))
      .onConflictDoNothing({ target: [pointTags.pointId, pointTags.tagId] })
      .run();
  }

  getTagsForPoints(pointIds: number[]): Map<number, string[]> {
    const result = new Map<number, string[]>();
    if (pointIds.length === 0) return result;
    const rows = this.db
      .select({ pointId: pointTags.pointId, name: tags.name })
      .from(pointTags)
      .innerJoin(tags, eq(pointTags.tagId, tags.id))
      .where(inArray(pointTags.pointId, pointIds))
      .all();
    for (const r of rows) {
      const existing = result.get(r.pointId);
      if (existing) existing.push(r.name);
      else result.set(r.pointId, [r.name]);
    }
    return result;
  }

  getPointById(id: number): KnowledgePoint | undefined {
    return this.db.select().from(knowledgePoints).where(eq(knowledgePoints.id, id)).get();
  }

  getActiveFactPointsForEntity(entityId: number): KnowledgePoint[] {
    return this.db
      .selectDistinct(getTableColumns(knowledgePoints))
      .from(knowledgePoints)
      .innerJoin(sourceEntityPoints, eq(knowledgePoints.id, sourceEntityPoints.pointId))
      .where(
        and(
          eq(sourceEntityPoints.entityId, entityId),
          eq(knowledgePoints.status, 'active'),
          eq(knowledgePoints.type, 'fact'),
        ),
      )
      .all();
  }

  getActiveFactPointsForEntities(entityIds: number[]): Map<number, KnowledgePoint[]> {
    const result = new Map<number, KnowledgePoint[]>();
    if (entityIds.length === 0) return result;
    const rows = this.db
      .selectDistinct({
        ...getTableColumns(knowledgePoints),
        entityId: sourceEntityPoints.entityId,
      })
      .from(knowledgePoints)
      .innerJoin(sourceEntityPoints, eq(knowledgePoints.id, sourceEntityPoints.pointId))
      .where(
        and(
          inArray(sourceEntityPoints.entityId, entityIds),
          eq(knowledgePoints.status, 'active'),
          eq(knowledgePoints.type, 'fact'),
        ),
      )
      .all();
    for (const r of rows) {
      const { entityId, ...point } = r;
      const list = result.get(entityId);
      if (list) list.push(point);
      else result.set(entityId, [point]);
    }
    return result;
  }

  getActivePointsForEntity(entityId: number): KnowledgePoint[] {
    return this.db
      .selectDistinct(getTableColumns(knowledgePoints))
      .from(knowledgePoints)
      .innerJoin(sourceEntityPoints, eq(knowledgePoints.id, sourceEntityPoints.pointId))
      .where(and(eq(sourceEntityPoints.entityId, entityId), eq(knowledgePoints.status, 'active')))
      .all();
  }

  createSourceEntityPoint(
    sourceId: number,
    entityId: number,
    pointId: number,
    judgment: Judgment,
  ): void {
    this.db
      .insert(sourceEntityPoints)
      .values({ sourceId, entityId, pointId, judgment })
      .onConflictDoNothing({
        target: [
          sourceEntityPoints.sourceId,
          sourceEntityPoints.entityId,
          sourceEntityPoints.pointId,
        ],
      })
      .run();
  }

  discardPoint(pointId: number): void {
    this.db
      .update(knowledgePoints)
      .set({ status: 'discarded', updatedAt: utcNowMs() })
      .where(eq(knowledgePoints.id, pointId))
      .run();
  }

  findOrphanPoints(): KnowledgePoint[] {
    return this.db
      .select()
      .from(knowledgePoints)
      .where(
        and(
          eq(knowledgePoints.status, 'active'),
          sql`NOT EXISTS (SELECT 1 FROM source_entity_points WHERE point_id = ${knowledgePoints.id})`,
        ),
      )
      .all();
  }

  getEntityIdsForSource(sourceId: number): number[] {
    const rows = this.db
      .selectDistinct({ entityId: sourceEntityPoints.entityId })
      .from(sourceEntityPoints)
      .where(eq(sourceEntityPoints.sourceId, sourceId))
      .all();
    return rows.map((r) => r.entityId);
  }

  entityHasActivePoints(entityId: number): boolean {
    const row = this.db.get(sql`
      SELECT 1 FROM source_entity_points sep
      JOIN knowledge_points kp ON sep.point_id = kp.id
      WHERE sep.entity_id = ${entityId} AND kp.status = 'active'
      LIMIT 1
    `);
    return !!row;
  }

  getPointsByIds(ids: number[]): KnowledgePoint[] {
    if (ids.length === 0) return [];
    return this.db.select().from(knowledgePoints).where(inArray(knowledgePoints.id, ids)).all();
  }

  getEntitiesByIds(ids: number[]): Array<Entity & { categoryPaths: string[] }> {
    if (ids.length === 0) return [];
    const rows = this.db
      .select({
        id: entities.id,
        name: entities.name,
        description: entities.description,
        descriptionTranslated: entities.descriptionTranslated,
        aliases: entities.aliases,
        keywords: entities.keywords,
        createdAt: entities.createdAt,
        updatedAt: entities.updatedAt,
        categoryPathsJson: sql<string>`json_group_array(DISTINCT ${categories.path})`.as(
          'category_paths_json',
        ),
      })
      .from(entities)
      .leftJoin(entityCategories, eq(entities.id, entityCategories.entityId))
      .leftJoin(categories, eq(entityCategories.categoryId, categories.id))
      .where(inArray(entities.id, ids))
      .groupBy(entities.id)
      .all();

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      descriptionTranslated: r.descriptionTranslated,
      aliases: r.aliases,
      keywords: r.keywords,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      categoryPaths: parseJsonStringArray(r.categoryPathsJson),
    }));
  }

  deleteSourceEntityPointsBySource(sourceId: number): void {
    this.db.delete(sourceEntityPoints).where(eq(sourceEntityPoints.sourceId, sourceId)).run();
  }

  getSourcesForEntity(entityId: number): Source[] {
    return this.db
      .selectDistinct(getTableColumns(sources))
      .from(sources)
      .innerJoin(sourceEntityPoints, eq(sourceEntityPoints.sourceId, sources.id))
      .where(eq(sourceEntityPoints.entityId, entityId))
      .all();
  }

  getCategoryPathsForEntity(entityId: number): string[] {
    const rows = this.db
      .select({ path: categories.path })
      .from(entityCategories)
      .innerJoin(categories, eq(entityCategories.categoryId, categories.id))
      .where(eq(entityCategories.entityId, entityId))
      .all();
    return rows.map((r) => r.path);
  }

  getRelationsForEntity(entityId: number): EntityRelation[] {
    const raw = getRawDatabase(this.db);
    return raw
      .prepare(
        `
      SELECT er.id, er.source_entity_id AS sourceEntityId, er.target_entity_id AS targetEntityId,
             se.name AS sourceEntityName, te.name AS targetEntityName,
             er.relation_type AS relationType, er.description,
             er.description_translated AS descriptionTranslated,
             er.source_id AS sourceId, er.created_at AS createdAt
      FROM entity_relations er
      JOIN entities se ON se.id = er.source_entity_id
      JOIN entities te ON te.id = er.target_entity_id
      WHERE er.source_entity_id = ? OR er.target_entity_id = ?
      ORDER BY er.created_at DESC
    `,
      )
      .all(entityId, entityId) as EntityRelation[];
  }

  getRelationsBetweenEntities(entityIds: number[]): EntityRelation[] {
    if (entityIds.length === 0) return [];
    const raw = getRawDatabase(this.db);
    const placeholders = entityIds.map(() => '?').join(',');
    return raw
      .prepare(
        `
      SELECT er.id, er.source_entity_id AS sourceEntityId, er.target_entity_id AS targetEntityId,
             se.name AS sourceEntityName, te.name AS targetEntityName,
             er.relation_type AS relationType, er.description,
             er.description_translated AS descriptionTranslated,
             er.source_id AS sourceId, er.created_at AS createdAt
      FROM entity_relations er
      JOIN entities se ON se.id = er.source_entity_id
      JOIN entities te ON te.id = er.target_entity_id
      WHERE er.source_entity_id IN (${placeholders})
         OR er.target_entity_id IN (${placeholders})
      ORDER BY er.created_at DESC
    `,
      )
      .all(...entityIds, ...entityIds) as EntityRelation[];
  }

  findRecentRelations({ sinceMs, limit }: FindRecentRelationsInput): RecentRelationRow[] {
    const raw = getRawDatabase(this.db);
    // CTE 先按 (created_at, id) DESC 排序 + LIMIT 再 JOIN 类别:否则每条关系会被
    // 扩成 |source.cats| × |target.cats| 行去重,类别多 + 时间窗大时是性能 landmine。
    // (created_at, id) 给同毫秒多关系一个稳定 tiebreaker。
    const rows = raw
      .prepare(`
      WITH r AS (
        SELECT id, source_entity_id, target_entity_id, relation_type, created_at
        FROM entity_relations
        WHERE created_at >= ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      )
      SELECT
        r.id,
        r.source_entity_id AS source_entity_id,
        r.target_entity_id AS target_entity_id,
        r.relation_type AS relation_type,
        r.created_at AS created_at,
        se.id AS s_id, se.name AS s_name,
        COALESCE(json_group_array(DISTINCT sc.path) FILTER (WHERE sc.path IS NOT NULL), '[]') AS s_paths,
        te.id AS t_id, te.name AS t_name,
        COALESCE(json_group_array(DISTINCT tc.path) FILTER (WHERE tc.path IS NOT NULL), '[]') AS t_paths
      FROM r
      JOIN entities se ON r.source_entity_id = se.id
      JOIN entities te ON r.target_entity_id = te.id
      LEFT JOIN entity_categories sec ON sec.entity_id = se.id
      LEFT JOIN categories sc ON sc.id = sec.category_id
      LEFT JOIN entity_categories tec ON tec.entity_id = te.id
      LEFT JOIN categories tc ON tc.id = tec.category_id
      GROUP BY r.id
      ORDER BY r.created_at DESC, r.id DESC
    `)
      .all(sinceMs, limit) as Array<{
      id: number;
      source_entity_id: number;
      target_entity_id: number;
      relation_type: EntityRelationType;
      created_at: number;
      s_id: number;
      s_name: string;
      s_paths: string;
      t_id: number;
      t_name: string;
      t_paths: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      sourceEntityId: r.source_entity_id,
      targetEntityId: r.target_entity_id,
      relationType: r.relation_type,
      createdAt: r.created_at,
      source: { id: r.s_id, name: r.s_name, categoryPaths: parseJsonStringArray(r.s_paths) },
      target: { id: r.t_id, name: r.t_name, categoryPaths: parseJsonStringArray(r.t_paths) },
    }));
  }
}
