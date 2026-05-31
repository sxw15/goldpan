import type { DrizzleDB } from '@goldpan/core/db';
import { getRawDatabase } from '@goldpan/core/db';
import { NOW_MS_SQL } from '@goldpan/core/db/sql-fragments';
import type { PluginRegistry } from '@goldpan/core/plugins';
import { insertPendingTrackingRule } from './db.js';
import type {
  CreateInterestInput,
  CreateInterestWithResolutionInput,
  Interest,
  InterestExecution,
  InterestExecutionDetail,
  InterestItem,
  InterestStats,
  PendingResolutionPayload,
  ResolutionStatus,
  TrackingService,
  UpdateInterestInput,
} from './types.js';
import { TrackingServiceError } from './types.js';

interface TrackingServiceDeps {
  db: DrizzleDB;
  pluginRegistry: PluginRegistry;
  scheduler: { startScheduler: () => void; drainScheduler: () => Promise<void> };
  /**
   * Reads the latest `minRuleIntervalMinutes` floor on every
   * createInterest / updateInterest decision so a `configStore.commit({
   * GOLDPAN_TRACKING_MIN_RULE_INTERVAL: ... })` is honored without a
   * restart. Closure-capturing the number at construction would re-introduce
   * the hot-reload bug.
   */
  getMinRuleIntervalMinutes: () => number;
}

interface RawInterestRow {
  id: number;
  name: string;
  description: string | null;
  search_queries_json: string;
  tool_provider: string | null;
  interval_minutes: number;
  enabled: number;
  status: string;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RawExecutionRow {
  id: number;
  rule_id: number;
  status: string;
  items_found: number;
  items_submitted: number;
  started_at: number;
  finished_at: number | null;
  error_message: string | null;
}

interface RawItemRow {
  id: number;
  url: string;
  title: string | null;
  snippet: string | null;
  published_at: number | null;
  status: string;
  source_id: number | null;
}

function mapInterestRow(row: RawInterestRow, linkedEntityIds: number[]): Interest {
  const searchQueries = JSON.parse(row.search_queries_json) as string[];
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    searchQueries,
    toolProvider: row.tool_provider,
    intervalMinutes: row.interval_minutes,
    enabled: Boolean(row.enabled),
    status: row.status as 'idle' | 'executing',
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    linkedEntityIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapExecutionRow(row: RawExecutionRow): InterestExecution {
  return {
    id: row.id,
    interestId: row.rule_id,
    status: row.status as 'running' | 'done' | 'error',
    itemsFound: row.items_found,
    itemsSubmitted: row.items_submitted,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorMessage: row.error_message,
  };
}

function mapItemRow(row: RawItemRow): InterestItem {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    snippet: row.snippet,
    publishedAt: row.published_at,
    status: row.status as 'found' | 'submitted' | 'duplicate' | 'failed',
    sourceId: row.source_id,
  };
}

export class TrackingCrudService implements TrackingService {
  private readonly db: DrizzleDB;
  private readonly pluginRegistry: PluginRegistry;
  private readonly scheduler: { startScheduler: () => void; drainScheduler: () => Promise<void> };
  private readonly getMinRuleIntervalMinutes: () => number;

  constructor(deps: TrackingServiceDeps) {
    this.db = deps.db;
    this.pluginRegistry = deps.pluginRegistry;
    this.scheduler = deps.scheduler;
    this.getMinRuleIntervalMinutes = deps.getMinRuleIntervalMinutes;
  }

  private getLinkedEntityIds(interestId: number): number[] {
    const rawDb = getRawDatabase(this.db);
    const rows = rawDb
      .prepare(
        `SELECT entity_id FROM interest_entity_links WHERE interest_id = ? ORDER BY entity_id`,
      )
      .all(interestId) as Array<{ entity_id: number }>;
    return rows.map((r) => r.entity_id);
  }

  /**
   * Normalize caller-supplied linkedEntityIds before writing to the junction
   * table.
   *
   * Without this, create/update drove raw ids into `INSERT INTO
   * interest_entity_links`: duplicate ids hit the composite primary key,
   * missing ids hit the FK to `entities(id)` — both surface as bare
   * better-sqlite3 errors that the route handler only catches as generic
   * 500 `internal`. The front end then shows "internal error" instead of a
   * specific "entity 42 not found" message.
   *
   * Dedupe in JS (Set preserves insertion order) rather than relying on the
   * PK to reject — we want a clean `validation_error` for callers, not an
   * opaque SQLITE_CONSTRAINT.
   */
  private validateLinkedEntityIds(ids: readonly number[]): number[] {
    const deduped = [...new Set(ids)];
    if (deduped.length === 0) return [];
    const rawDb = getRawDatabase(this.db);
    const placeholders = deduped.map(() => '?').join(',');
    const existing = rawDb
      .prepare(`SELECT id FROM entities WHERE id IN (${placeholders})`)
      .all(...deduped) as Array<{ id: number }>;
    if (existing.length !== deduped.length) {
      const foundSet = new Set(existing.map((r) => r.id));
      const missing = deduped.filter((id) => !foundSet.has(id));
      throw new TrackingServiceError(
        'validation_error',
        `linkedEntityIds references unknown entities: ${missing.join(', ')}`,
      );
    }
    return deduped;
  }

  getInterests(): Interest[] {
    const rawDb = getRawDatabase(this.db);
    const rows = rawDb
      .prepare('SELECT * FROM tracking_rules ORDER BY id')
      .all() as RawInterestRow[];
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const linkRows = rawDb
      .prepare(
        `SELECT interest_id, entity_id FROM interest_entity_links WHERE interest_id IN (${placeholders}) ORDER BY entity_id`,
      )
      .all(...ids) as Array<{ interest_id: number; entity_id: number }>;
    const linksByInterest = new Map<number, number[]>();
    for (const link of linkRows) {
      const arr = linksByInterest.get(link.interest_id);
      if (arr) arr.push(link.entity_id);
      else linksByInterest.set(link.interest_id, [link.entity_id]);
    }
    return rows.map((row) => mapInterestRow(row, linksByInterest.get(row.id) ?? []));
  }

  /**
   * Batch fetch per-interest aggregates via two GROUP-BY queries against
   * `tracking_executions`. Returns a `Map<ruleId, InterestStats>` keyed only
   * by interests that have at least one execution; the route layer fills
   * zeros for the rest so the SDK contract has every list item defined.
   *
   * Sparkline is a 14-element array (oldest → newest day, UTC date
   * boundaries). Days with zero executions become `0` rather than missing —
   * fixed length is part of the contract, see `InterestStats` doc.
   */
  getInterestListStats(): Map<number, InterestStats> {
    const rawDb = getRawDatabase(this.db);

    // The scalar `newHits24h` is a sliding 24-hour window so the field name
    // and UI copy stay honest. The sparkline below uses calendar-day buckets
    // because that's what the 14-day timeline answers; the two windows are
    // shown in distinct columns and don't share a boundary.
    const scalars = rawDb
      .prepare(
        `SELECT
           rule_id                                                                                          AS rule_id,
           COALESCE(SUM(items_found), 0)                                                                    AS total_hits,
           COALESCE(SUM(CASE WHEN started_at >= ${NOW_MS_SQL} - 86400000 THEN items_found ELSE 0 END), 0) AS new_hits_24h,
           COALESCE(SUM(items_submitted), 0)                                                                AS ingested_total
         FROM tracking_executions
         GROUP BY rule_id`,
      )
      .all() as Array<{
      rule_id: number;
      total_hits: number;
      new_hits_24h: number;
      ingested_total: number;
    }>;

    const buckets = rawDb
      .prepare(
        `SELECT
           rule_id                                                              AS rule_id,
           date(started_at / 1000, 'unixepoch')                                  AS day,
           COALESCE(SUM(items_found), 0)                                         AS hits
         FROM tracking_executions
         WHERE started_at >= CAST(ROUND((julianday(date('now', '-13 days')) - 2440587.5) * 86400000) AS INTEGER)
         GROUP BY rule_id, day`,
      )
      .all() as Array<{ rule_id: number; day: string; hits: number }>;

    // Calendar comes from SQLite (same clock as the query above) — using
    // `new Date()` here would race the SQL queries across UTC midnight and
    // could leave the last sparkline bar empty when the scalar query
    // already counted the new day.
    const days = (
      rawDb
        .prepare(
          `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 13)
           SELECT date('now', '-' || (13 - i) || ' days') AS d FROM n ORDER BY i`,
        )
        .all() as Array<{ d: string }>
    ).map((r) => r.d);

    const bucketsByRule = new Map<number, Map<string, number>>();
    for (const b of buckets) {
      let perDay = bucketsByRule.get(b.rule_id);
      if (!perDay) {
        perDay = new Map();
        bucketsByRule.set(b.rule_id, perDay);
      }
      perDay.set(b.day, b.hits);
    }

    const result = new Map<number, InterestStats>();
    for (const s of scalars) {
      const perDay = bucketsByRule.get(s.rule_id);
      const sparkline = days.map((d) => perDay?.get(d) ?? 0);
      result.set(s.rule_id, {
        totalHits: s.total_hits,
        newHits24h: s.new_hits_24h,
        ingestedTotal: s.ingested_total,
        sparkline,
      });
    }
    return result;
  }

  getInterest(id: number): Interest | undefined {
    const rawDb = getRawDatabase(this.db);
    const row = rawDb.prepare('SELECT * FROM tracking_rules WHERE id = ?').get(id) as
      | RawInterestRow
      | undefined;
    return row ? mapInterestRow(row, this.getLinkedEntityIds(id)) : undefined;
  }

  private expectInterest(id: number): Interest {
    const interest = this.getInterest(id);
    if (!interest) {
      throw new TrackingServiceError('not_found', `Interest ${id} not found`);
    }
    return interest;
  }

  private validateSearchQueries(queries: string[]): void {
    if (!Array.isArray(queries) || queries.length === 0) {
      throw new TrackingServiceError('validation_error', 'searchQueries must have >= 1 item');
    }
    if (queries.length > 20) {
      throw new TrackingServiceError('validation_error', 'searchQueries must have <= 20 items');
    }
    for (const q of queries) {
      if (typeof q !== 'string' || q.length === 0 || q.length > 100) {
        throw new TrackingServiceError(
          'validation_error',
          'each searchQuery must be non-empty string <= 100 chars',
        );
      }
    }
    // The executor joins with ' OR ' before handing to the search tool
    // (see plugins/tracking/src/executor.ts buildSearchQuery). The core search
    // schema caps `query` at 500 chars (packages/core/src/plugins/search-schema.ts).
    // Without this check, 20 × 100-char queries could produce a ~2000-char
    // joined string that fails inside the tool as ToolInputValidationError —
    // the user would only learn after the next scheduler cycle via the
    // interest-payload error message. Fail fast at create/update time instead.
    const joinedLength = queries.reduce((acc, q) => acc + q.length, 0) + (queries.length - 1) * 4;
    if (joinedLength > 500) {
      throw new TrackingServiceError(
        'validation_error',
        `joined searchQueries length (${joinedLength}) exceeds 500 chars after ' OR ' concatenation`,
      );
    }
  }

  createInterest(data: CreateInterestInput): Interest {
    const trimmedName = data.name.trim();
    if (!trimmedName) {
      throw new TrackingServiceError('validation_error', 'Interest name must not be empty');
    }
    if (trimmedName.length > 200) {
      throw new TrackingServiceError(
        'validation_error',
        'Interest name must not exceed 200 characters',
      );
    }

    this.validateSearchQueries(data.searchQueries);

    const description = data.description?.trim() || null;
    if (description && description.length > 500) {
      throw new TrackingServiceError('validation_error', 'description must be <= 500 characters');
    }

    if (data.toolProvider) {
      const resolved = this.pluginRegistry.resolveToolProvider(data.toolProvider, 'search');
      if (!resolved) {
        throw new TrackingServiceError(
          'invalid_provider',
          `Tool provider '${data.toolProvider}' not found or does not support 'search'`,
        );
      }
    }

    const interval = Math.max(data.intervalMinutes ?? 60, this.getMinRuleIntervalMinutes());
    const enabled = data.enabled === undefined ? 1 : data.enabled ? 1 : 0;

    const rawDb = getRawDatabase(this.db);
    return rawDb
      .transaction(() => {
        const result = rawDb
          .prepare(
            `INSERT INTO tracking_rules (name, description, search_queries_json, tool_provider, interval_minutes, enabled, next_run_at)
             VALUES (?, ?, ?, ?, ?, ?, ${NOW_MS_SQL})`,
          )
          .run(
            trimmedName,
            description,
            JSON.stringify(data.searchQueries),
            data.toolProvider ?? null,
            interval,
            enabled,
          );
        const id = Number(result.lastInsertRowid);

        if (data.linkedEntityIds && data.linkedEntityIds.length > 0) {
          const ids = this.validateLinkedEntityIds(data.linkedEntityIds);
          const linkStmt = rawDb.prepare(
            `INSERT INTO interest_entity_links (interest_id, entity_id) VALUES (?, ?)`,
          );
          for (const entityId of ids) {
            linkStmt.run(id, entityId);
          }
        }

        return this.expectInterest(id);
      })
      .immediate();
  }

  /**
   * P2 `create_tracking` only. Resolved rows delegate to the normal
   * management-CRUD path so provider/search-query/interval validations stay
   * consistent. Non-resolved rows bypass those validations intentionally: they
   * carry placeholder values that the P4 deferred resolver will rewrite.
   *
   * Pending inserts delegate to `insertPendingTrackingRule` so the raw SQL
   * stays alongside other DDL/DML in `db.ts`.
   */
  createInterestWithResolution(data: CreateInterestWithResolutionInput): {
    id: number;
    name: string;
  } {
    if (data.resolutionStatus === 'resolved') {
      const interest = this.createInterest({
        name: data.name,
        ...(data.description !== undefined ? { description: data.description } : {}),
        searchQueries: data.searchQueries,
        ...(data.toolProvider !== undefined ? { toolProvider: data.toolProvider } : {}),
        ...(data.intervalMinutes !== undefined ? { intervalMinutes: data.intervalMinutes } : {}),
        ...(data.linkedEntityIds !== undefined ? { linkedEntityIds: data.linkedEntityIds } : {}),
        enabled: data.enabled,
      });
      return { id: interest.id, name: interest.name };
    }

    // Validate the linked entities exist (would fail with SQLITE_FOREIGN_KEY
    // on INSERT into interest_entity_links, but that surfaces as an opaque
    // 500; better to fail with a clear validation_error here matching
    // createInterest's behavior).
    if (data.linkedEntityIds && data.linkedEntityIds.length > 0) {
      this.validateLinkedEntityIds(data.linkedEntityIds);
    }
    return insertPendingTrackingRule(this.db, data);
  }

  updateInterest(id: number, data: UpdateInterestInput): Interest {
    const rawDb = getRawDatabase(this.db);

    if (data.toolProvider !== undefined && data.toolProvider) {
      const resolved = this.pluginRegistry.resolveToolProvider(data.toolProvider, 'search');
      if (!resolved) {
        throw new TrackingServiceError(
          'invalid_provider',
          `Tool provider '${data.toolProvider}' not found or does not support 'search'`,
        );
      }
    }

    if (data.searchQueries !== undefined) this.validateSearchQueries(data.searchQueries);

    return rawDb
      .transaction(() => {
        const existing = this.getInterest(id);
        if (!existing) {
          throw new TrackingServiceError('not_found', `Interest ${id} not found`);
        }

        let name = existing.name;
        if (data.name !== undefined) {
          const trimmedName = data.name.trim();
          if (!trimmedName) {
            throw new TrackingServiceError('validation_error', 'Interest name must not be empty');
          }
          if (trimmedName.length > 200) {
            throw new TrackingServiceError(
              'validation_error',
              'Interest name must not exceed 200 characters',
            );
          }
          name = trimmedName;
        }

        let description = existing.description;
        if (data.description !== undefined) {
          const trimmed = data.description.trim() || null;
          if (trimmed && trimmed.length > 500) {
            throw new TrackingServiceError(
              'validation_error',
              'description must be <= 500 characters',
            );
          }
          description = trimmed;
        }

        const searchQueries = data.searchQueries ?? existing.searchQueries;

        const toolProvider =
          data.toolProvider !== undefined ? data.toolProvider || null : existing.toolProvider;
        const interval = data.intervalMinutes
          ? Math.max(data.intervalMinutes, this.getMinRuleIntervalMinutes())
          : existing.intervalMinutes;

        rawDb
          .prepare(
            `UPDATE tracking_rules
             SET name = ?, description = ?, search_queries_json = ?, tool_provider = ?, interval_minutes = ?, updated_at = ${NOW_MS_SQL}
             WHERE id = ?`,
          )
          .run(name, description, JSON.stringify(searchQueries), toolProvider, interval, id);

        if (data.linkedEntityIds !== undefined) {
          // Validate BEFORE deleting so a bad id cannot wipe the existing link
          // set (the transaction would roll back, but the error would then be
          // SQLITE_CONSTRAINT rather than validation_error).
          const ids = this.validateLinkedEntityIds(data.linkedEntityIds);
          rawDb.prepare(`DELETE FROM interest_entity_links WHERE interest_id = ?`).run(id);
          if (ids.length > 0) {
            const linkStmt = rawDb.prepare(
              `INSERT INTO interest_entity_links (interest_id, entity_id) VALUES (?, ?)`,
            );
            for (const entityId of ids) {
              linkStmt.run(id, entityId);
            }
          }
        }

        return this.expectInterest(id);
      })
      .immediate();
  }

  deleteInterest(id: number): void {
    const rawDb = getRawDatabase(this.db);
    rawDb
      .transaction(() => {
        const row = rawDb.prepare('SELECT status FROM tracking_rules WHERE id = ?').get(id) as
          | { status: string }
          | undefined;
        if (!row) {
          throw new TrackingServiceError('not_found', `Interest ${id} not found`);
        }
        if (row.status === 'executing') {
          throw new TrackingServiceError(
            'conflict',
            `Cannot delete interest ${id} while executing`,
          );
        }
        rawDb.prepare('DELETE FROM tracking_rules WHERE id = ?').run(id);
        rawDb
          .prepare('UPDATE sources SET tracking_rule_id = NULL WHERE tracking_rule_id = ?')
          .run(id);
      })
      .immediate();
  }

  enableInterest(id: number): Interest {
    const rawDb = getRawDatabase(this.db);
    const row = rawDb
      .prepare('SELECT resolution_status FROM tracking_rules WHERE id = ?')
      .get(id) as { resolution_status: string } | undefined;
    if (!row) {
      throw new TrackingServiceError('not_found', `Interest ${id} not found`);
    }
    if (row.resolution_status !== 'resolved') {
      throw new TrackingServiceError(
        'conflict',
        `Interest ${id} is still pending resolution and cannot be enabled`,
      );
    }
    const result = rawDb
      .prepare(`UPDATE tracking_rules SET enabled = 1, updated_at = ${NOW_MS_SQL} WHERE id = ?`)
      .run(id);
    if (result.changes === 0)
      throw new TrackingServiceError('not_found', `Interest ${id} not found`);
    return this.expectInterest(id);
  }

  disableInterest(id: number): Interest {
    const rawDb = getRawDatabase(this.db);
    const result = rawDb
      .prepare(`UPDATE tracking_rules SET enabled = 0, updated_at = ${NOW_MS_SQL} WHERE id = ?`)
      .run(id);
    if (result.changes === 0) {
      throw new TrackingServiceError('not_found', `Interest ${id} not found`);
    }
    return this.expectInterest(id);
  }

  triggerExecution(interestId: number): void {
    const rawDb = getRawDatabase(this.db);
    const result = rawDb
      .prepare(
        `UPDATE tracking_rules
         SET next_run_at = ${NOW_MS_SQL}, updated_at = ${NOW_MS_SQL}
         WHERE id = ? AND status != 'executing' AND enabled = 1`,
      )
      .run(interestId);

    if (result.changes === 0) {
      const row = rawDb
        .prepare('SELECT status, enabled FROM tracking_rules WHERE id = ?')
        .get(interestId) as { status: string; enabled: number } | undefined;
      if (!row) {
        throw new TrackingServiceError('not_found', `Interest ${interestId} not found`);
      }
      if (!row.enabled) {
        throw new TrackingServiceError('conflict', 'Interest is disabled');
      }
      throw new TrackingServiceError('conflict', `Interest ${interestId} is currently executing`);
    }
  }

  getExecution(id: number): InterestExecutionDetail | undefined {
    const rawDb = getRawDatabase(this.db);
    const row = rawDb.prepare('SELECT * FROM tracking_executions WHERE id = ?').get(id) as
      | RawExecutionRow
      | undefined;
    if (!row) return undefined;

    const items = rawDb
      .prepare('SELECT * FROM tracking_items WHERE execution_id = ? ORDER BY id')
      .all(id) as RawItemRow[];

    return {
      ...mapExecutionRow(row),
      items: items.map(mapItemRow),
    };
  }

  getInterestExecutions(
    interestId: number,
    options?: { page?: number; perPage?: number },
  ): { executions: InterestExecution[]; total: number } {
    const existing = this.getInterest(interestId);
    if (!existing) {
      throw new TrackingServiceError('not_found', `Interest ${interestId} not found`);
    }

    const page = Math.max(options?.page ?? 1, 1);
    const perPage = Math.min(Math.max(options?.perPage ?? 30, 1), 100);
    const offset = (page - 1) * perPage;

    const rawDb = getRawDatabase(this.db);
    const totalRow = rawDb
      .prepare('SELECT COUNT(*) as count FROM tracking_executions WHERE rule_id = ?')
      .get(interestId) as { count: number };
    const total = totalRow.count;

    const rows = rawDb
      .prepare(
        'SELECT * FROM tracking_executions WHERE rule_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?',
      )
      .all(interestId, perPage, offset) as RawExecutionRow[];

    return { executions: rows.map(mapExecutionRow), total };
  }

  startScheduler(): void {
    this.scheduler.startScheduler();
  }

  async drainScheduler(): Promise<void> {
    await this.scheduler.drainScheduler();
  }

  // ─── P4 deferred resolver helpers ────────────────────────
  //
  // Cross-cuts the normal CRUD path: P4 `deferredResolver` polls these to
  // promote rows seeded by `create_tracking` (status=pending_pipeline,
  // enabled=0) once the upstream source pipeline terminates. All transitions
  // are CAS (`AND resolution_status = ?`) so two resolvers racing on the
  // same row only let one through — the loser sees `changes === 0` and
  // backs off without touching state.

  findPendingByPipelineSource(
    sourceId: number,
  ): Array<{ id: number; pendingResolution: PendingResolutionPayload | null }> {
    const rawDb = getRawDatabase(this.db);
    const rows = rawDb
      .prepare(
        `SELECT id, pending_resolution
         FROM tracking_rules
         WHERE resolution_status = 'pending_pipeline'
           AND json_extract(pending_resolution, '$.sourceId') = ?`,
      )
      .all(sourceId) as Array<{ id: number; pending_resolution: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      pendingResolution: r.pending_resolution
        ? (JSON.parse(r.pending_resolution) as PendingResolutionPayload)
        : null,
    }));
  }

  markResolved(
    id: number,
    input: {
      name: string;
      searchQueries: string[];
      linkedEntityIds: number[];
      expectedStatus: ResolutionStatus;
    },
  ): boolean {
    const rawDb = getRawDatabase(this.db);
    return (
      rawDb
        .transaction(() => {
          const result = rawDb
            .prepare(
              `UPDATE tracking_rules
               SET resolution_status = 'resolved',
                   enabled = 1,
                   name = ?,
                   search_queries_json = ?,
                   updated_at = ${NOW_MS_SQL}
               WHERE id = ? AND resolution_status = ?`,
            )
            .run(input.name, JSON.stringify(input.searchQueries), id, input.expectedStatus);
          if ((result.changes ?? 0) === 0) return false;
          // INSERT OR IGNORE keeps the resolver idempotent: if an earlier
          // partial run already wrote the junction row (or the entity was
          // manually linked), we don't blow up the whole transaction.
          const linkStmt = rawDb.prepare(
            `INSERT OR IGNORE INTO interest_entity_links (interest_id, entity_id) VALUES (?, ?)`,
          );
          for (const entityId of input.linkedEntityIds) {
            linkStmt.run(id, entityId);
          }
          return true;
        })
        .immediate() ?? false
    );
  }

  markFailedResolution(
    id: number,
    input: {
      targetStatus: 'failed_no_entity' | 'failed_source_pipeline';
      expectedStatus: ResolutionStatus;
    },
  ): boolean {
    const rawDb = getRawDatabase(this.db);
    const result = rawDb
      .prepare(
        `UPDATE tracking_rules
         SET resolution_status = ?, enabled = 0, updated_at = ${NOW_MS_SQL}
         WHERE id = ? AND resolution_status = ?`,
      )
      .run(input.targetStatus, id, input.expectedStatus);
    return (result.changes ?? 0) > 0;
  }

  markAwaitingClarify(
    id: number,
    input: { candidateEntityIds: number[]; expectedStatus: ResolutionStatus },
  ): boolean {
    const rawDb = getRawDatabase(this.db);
    // json_set on a single path mutates only `$.candidateEntityIds`;
    // conversationId / sessionRef / placeholderName written at create time
    // survive (verified against SQLite json1 docs — sibling keys are not
    // touched). The handler snapshotted those for IM replay after resolve.
    // B6: 同时写 awaiting_clarify_since，作为 clarify-timeout 的唯一时刻基准。
    const result = rawDb
      .prepare(
        `UPDATE tracking_rules
         SET resolution_status = 'awaiting_clarify',
             enabled = 0,
             pending_resolution = json_set(
               COALESCE(pending_resolution, '{}'),
               '$.candidateEntityIds', json(?)
             ),
             awaiting_clarify_since = ${NOW_MS_SQL},
             updated_at = ${NOW_MS_SQL}
         WHERE id = ? AND resolution_status = ?`,
      )
      .run(JSON.stringify(input.candidateEntityIds), id, input.expectedStatus);
    return (result.changes ?? 0) > 0;
  }

  findAwaitingClarifyOlderThan(
    cutoffMs: number,
  ): Array<{ id: number; pendingResolution: PendingResolutionPayload | null }> {
    const rawDb = getRawDatabase(this.db);
    // B6: 用 awaiting_clarify_since 而非 updated_at —— 后者会被 updateInterest
    // 等无关 UPDATE bumped，导致 24h timer 静默重置。
    // COALESCE 处理 v5→v6 migration 之前已存在的 awaiting_clarify 行：
    // 这些行 awaiting_clarify_since 为 NULL，回退到 updated_at（保留旧语义）。
    const rows = rawDb
      .prepare(
        `SELECT id, pending_resolution
         FROM tracking_rules
         WHERE resolution_status = 'awaiting_clarify'
           AND COALESCE(awaiting_clarify_since, updated_at) < ?`,
      )
      .all(cutoffMs) as Array<{ id: number; pending_resolution: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      pendingResolution: r.pending_resolution
        ? (JSON.parse(r.pending_resolution) as PendingResolutionPayload)
        : null,
    }));
  }
}
