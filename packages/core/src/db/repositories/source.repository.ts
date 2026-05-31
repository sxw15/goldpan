import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../connection';
import { parseJsonStringArray } from '../json-columns';
import { categories, entities, entityCategories, sourceEntityPoints, sources } from '../schema';
import { utcNowMs } from '../timestamp';
import type {
  CreateSourceInput,
  JsonObject,
  Source,
  SourceListFilter,
  SourceListItem,
  SourceRepository,
  SourceStatus,
  SourceStatusCounts,
  SourceWithEntities,
} from './types';

export interface SourceRepositoryDeps {
  /**
   * Invoked after `updateStatus` writes a terminal status. P4's
   * deferredResolver hooks here to materialize any pending tracking rule that
   * was waiting on this source. Callers that update status inside a raw DB
   * transaction must pass `{ emitTerminated: false }` and invoke
   * `emitTerminated` only after commit succeeds.
   * Minor: 命名与 deferred/resolver.ts:onSourceTerminated 对齐。
   */
  onSourceTerminated?: (sourceId: number, status: SourceStatus) => void;
}

const TERMINAL_STATUSES: readonly SourceStatus[] = [
  'confirmed',
  'confirmed_empty',
  'failed',
  'discarded',
];

export class SqliteSourceRepository implements SourceRepository {
  constructor(
    private db: DrizzleDB,
    private deps?: SourceRepositoryDeps,
  ) {}

  create(input: CreateSourceInput): Source {
    const [src] = this.db
      .insert(sources)
      .values({
        kind: input.kind,
        normalizedUrl: input.normalizedUrl ?? null,
        originalUrl: input.originalUrl ?? null,
        rawContent: input.rawContent ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      })
      .returning()
      .all();
    return src;
  }

  getById(id: number): Source | undefined {
    return this.db.select().from(sources).where(eq(sources.id, id)).get();
  }

  getByIds(ids: number[]): Source[] {
    if (ids.length === 0) return [];
    return this.db.select().from(sources).where(inArray(sources.id, ids)).all();
  }

  findActiveByNormalizedUrl(normalizedUrl: string): Source | undefined {
    return this.db
      .select()
      .from(sources)
      .where(
        and(
          eq(sources.normalizedUrl, normalizedUrl),
          inArray(sources.status, ['processing', 'confirmed']),
        ),
      )
      .get();
  }

  updateStatus(id: number, status: SourceStatus, options?: { emitTerminated?: boolean }): void {
    // B1: 显式 SELECT 比较 —— 不能依赖 `result.changes === 0`，因为本 UPDATE
    // set 了 updatedAt: utcNowMs()，no-op 也会 bump 行，导致 changes 永远 > 0。
    // 同状态重入时直接 return：不写 updatedAt，不 fire callback，防 deferred
    // resolver 重跑 backfill / pushAssistant。
    //
    // 包在 IMMEDIATE transaction 内 —— better-sqlite3 single-connection 是
    // process-local 串行；但同 DB 文件多进程时 DEFERRED transaction 的 SELECT
    // 不锁 row（共享锁），两进程都能 SELECT 旧 status，第二个 UPDATE 升 RESERVED
    // 时 SQLITE_BUSY。IMMEDIATE 立即取 RESERVED 锁，第二个 caller 在 BEGIN 时
    // 等到第一个 commit，看到的就是新 status，early-return。
    const shouldEmit = this.db.transaction(
      (tx) => {
        const existing = tx
          .select({ status: sources.status })
          .from(sources)
          .where(eq(sources.id, id))
          .get();
        if (!existing) {
          throw new Error(`Source not found: ${id}`);
        }
        if (existing.status === status) {
          return false;
        }
        tx.update(sources).set({ status, updatedAt: utcNowMs() }).where(eq(sources.id, id)).run();
        return true;
      },
      { behavior: 'immediate' },
    );
    if (shouldEmit && options?.emitTerminated !== false) this.emitTerminated(id, status);
  }

  emitTerminated(id: number, status: SourceStatus): void {
    if (TERMINAL_STATUSES.includes(status)) {
      this.deps?.onSourceTerminated?.(id, status);
    }
  }

  updateAfterCollecting(
    id: number,
    data: {
      title?: string;
      rawContent: string;
      collectorMetadata?: JsonObject;
    },
  ): void {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Source not found: ${id}`);
    if (existing.kind !== 'external') {
      throw new Error(`Only external sources can be collected, got kind: ${existing.kind}`);
    }
    let existingMeta: JsonObject = {};
    if (existing.metadata) {
      try {
        existingMeta = JSON.parse(existing.metadata);
      } catch {
        /* corrupted metadata, reset */
      }
    }
    const merged = Object.assign({}, existingMeta, data.collectorMetadata ?? {});

    const result = this.db
      .update(sources)
      .set({
        title: data.title !== undefined ? data.title : (existing?.title ?? null),
        rawContent: data.rawContent,
        metadata: Object.keys(merged).length > 0 ? JSON.stringify(merged) : null,
        updatedAt: utcNowMs(),
      })
      .where(eq(sources.id, id))
      .run();
    if (result.changes === 0) {
      throw new Error(`Source disappeared during updateAfterCollecting: ${id}`);
    }
  }

  mergeMetadata(id: number, patch: Record<string, unknown>): void {
    const row = this.db
      .select({ metadata: sources.metadata })
      .from(sources)
      .where(eq(sources.id, id))
      .get();
    if (!row) return;
    let current: Record<string, unknown> = {};
    if (typeof row.metadata === 'string' && row.metadata.length > 0) {
      try {
        const parsed = JSON.parse(row.metadata);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          current = parsed as Record<string, unknown>;
        }
      } catch {
        current = {};
      }
    }
    const merged = { ...current, ...patch };
    this.db
      .update(sources)
      .set({ metadata: JSON.stringify(merged), updatedAt: utcNowMs() })
      .where(eq(sources.id, id))
      .run();
  }

  getByStatus(status: SourceStatus, limit = 50): Source[] {
    return this.db.select().from(sources).where(eq(sources.status, status)).limit(limit).all();
  }

  /**
   * Reset failed sources whose associated tasks have been reset to 'pending'.
   * Called after taskRepo.resetAllProcessing() to bring source status back
   * to 'processing' so the pipeline can re-attempt them.
   *
   * @internal Currently unused — the pipeline naturally re-sets source status
   * during re-processing. Retained for potential future manual recovery flows.
   */
  resetFailedSourcesToProcessing(): number {
    const result = this.db
      .update(sources)
      .set({ status: 'processing', updatedAt: utcNowMs() })
      .where(
        and(
          inArray(sources.status, ['failed']),
          sql`${sources.id} IN (SELECT source_id FROM processing_tasks WHERE status = 'pending')`,
        ),
      )
      .run();
    return result.changes;
  }

  list(filter?: SourceListFilter): SourceListItem[] {
    const conditions = [];
    if (filter?.status !== undefined) {
      const statuses: readonly SourceStatus[] = Array.isArray(filter.status)
        ? filter.status
        : [filter.status as SourceStatus];
      if (statuses.length === 0) {
        throw new Error(
          'SourceListFilter.status: empty array is ambiguous (use undefined for "all").',
        );
      }
      if (statuses.length === 1) conditions.push(eq(sources.status, statuses[0]));
      else conditions.push(inArray(sources.status, [...statuses]));
    }
    if (filter?.origin) conditions.push(eq(sources.origin, filter.origin));

    const rows = this.db
      .select({
        id: sources.id,
        kind: sources.kind,
        originalUrl: sources.originalUrl,
        normalizedUrl: sources.normalizedUrl,
        title: sources.title,
        status: sources.status,
        origin: sources.origin,
        createdAt: sources.createdAt,
        // SQL-side substring: external rows can have multi-KB rawContent and we only need the first 80 chars for user kind.
        preview: sql<
          string | null
        >`CASE WHEN ${sources.kind} = 'user' THEN substr(${sources.rawContent}, 1, 80) ELSE NULL END`.as(
          'preview',
        ),
        kpCount: sql<number>`COUNT(DISTINCT ${sourceEntityPoints.pointId})`.as('kp_count'),
        entityCount: sql<number>`COUNT(DISTINCT ${sourceEntityPoints.entityId})`.as('entity_count'),
      })
      .from(sources)
      .leftJoin(sourceEntityPoints, eq(sourceEntityPoints.sourceId, sources.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(sources.id)
      .orderBy(sql`${sources.createdAt} DESC`)
      .limit(filter?.limit ?? 100)
      .all();

    if (rows.length === 0) return [];

    const sourceIds = rows.map((r) => r.id);
    const topEntitiesMap = new Map<number, { id: number; name: string }[]>();
    if (sourceIds.length > 0) {
      const entRows = this.db
        .select({
          sourceId: sourceEntityPoints.sourceId,
          entityId: sourceEntityPoints.entityId,
          name: entities.name,
          perCount: sql<number>`COUNT(DISTINCT ${sourceEntityPoints.pointId})`.as('per_count'),
        })
        .from(sourceEntityPoints)
        .innerJoin(entities, eq(entities.id, sourceEntityPoints.entityId))
        .where(inArray(sourceEntityPoints.sourceId, sourceIds))
        .groupBy(sourceEntityPoints.sourceId, sourceEntityPoints.entityId)
        .all();
      const grouped = new Map<number, { id: number; name: string; perCount: number }[]>();
      for (const r of entRows) {
        const arr = grouped.get(r.sourceId) ?? [];
        arr.push({ id: r.entityId, name: r.name, perCount: Number(r.perCount) });
        grouped.set(r.sourceId, arr);
      }
      for (const [sid, arr] of grouped.entries()) {
        // Tie-break by entityId so SQLite's groupBy ordering doesn't leak into the response.
        arr.sort((a, b) => b.perCount - a.perCount || a.id - b.id);
        topEntitiesMap.set(
          sid,
          arr.slice(0, 3).map(({ id, name }) => ({ id, name })),
        );
      }
    }

    const categoryPathsMap = new Map<number, string[]>();
    if (sourceIds.length > 0) {
      const catRows = this.db
        .select({
          sourceId: sourceEntityPoints.sourceId,
          path: categories.path,
        })
        .from(sourceEntityPoints)
        .innerJoin(entityCategories, eq(entityCategories.entityId, sourceEntityPoints.entityId))
        .innerJoin(categories, eq(categories.id, entityCategories.categoryId))
        .where(inArray(sourceEntityPoints.sourceId, sourceIds))
        .groupBy(sourceEntityPoints.sourceId, categories.path)
        .all();
      for (const r of catRows) {
        const arr = categoryPathsMap.get(r.sourceId) ?? [];
        arr.push(r.path);
        categoryPathsMap.set(r.sourceId, arr);
      }
    }

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as 'external' | 'user',
      originalUrl: r.originalUrl,
      normalizedUrl: r.normalizedUrl,
      title: r.title,
      status: r.status as SourceStatus,
      origin: r.origin,
      createdAt: r.createdAt,
      kpCount: Number(r.kpCount),
      entityCount: Number(r.entityCount),
      topEntities: topEntitiesMap.get(r.id) ?? [],
      entityCategoryPaths: categoryPathsMap.get(r.id) ?? [],
      preview: r.preview,
    }));
  }

  getDetailWithEntities(id: number): SourceWithEntities | null {
    const src = this.getById(id);
    if (!src) return null;

    // Step 1: distinct entity ids from source_entity_points.
    // NOTE: Includes entities linked via points of ANY status (active or discarded).
    // SourcePayload surfaces the full historical reach of a source so users can
    // still see which entities it touched even after its points were discarded.
    const entityIdRows = this.db
      .select({ entityId: sourceEntityPoints.entityId })
      .from(sourceEntityPoints)
      .where(eq(sourceEntityPoints.sourceId, id))
      .groupBy(sourceEntityPoints.entityId)
      .all();

    const entityIds = entityIdRows.map((r) => r.entityId);
    if (entityIds.length === 0) {
      return { source: src, entities: [], entityCount: 0 };
    }

    // Step 2: batched entity + categoryPaths query (same shape as knowledge.repository.ts getEntityRegistry)
    const entRows = this.db
      .select({
        id: entities.id,
        name: entities.name,
        categoryPathsJson: sql<string>`json_group_array(DISTINCT ${categories.path})`.as(
          'category_paths_json',
        ),
      })
      .from(entities)
      .leftJoin(entityCategories, eq(entities.id, entityCategories.entityId))
      .leftJoin(categories, eq(entityCategories.categoryId, categories.id))
      .where(inArray(entities.id, entityIds))
      .groupBy(entities.id)
      .all();

    const entitiesResult = entRows.map((r) => ({
      id: r.id,
      name: r.name,
      categoryPaths: parseJsonStringArray(r.categoryPathsJson),
    }));

    return { source: src, entities: entitiesResult, entityCount: entitiesResult.length };
  }

  getStatusCounts(): SourceStatusCounts {
    const rows = this.db
      .select({
        status: sources.status,
        count: sql<number>`COUNT(*)`.as('count'),
      })
      .from(sources)
      .groupBy(sources.status)
      .all();
    const result: SourceStatusCounts = {
      processing: 0,
      confirmed: 0,
      confirmed_empty: 0,
      failed: 0,
      discarded: 0,
    };
    for (const r of rows) {
      const s = r.status as SourceStatus;
      result[s] = Number(r.count);
    }
    return result;
  }
}
