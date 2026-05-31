import type { DrizzleDB } from '@goldpan/core/db';
import { getRawDatabase } from '@goldpan/core/db';
import { NOW_MS_SQL } from '@goldpan/core/db/sql-fragments';
import type { CreateInterestWithResolutionInput } from './types.js';

type RawDb = ReturnType<typeof getRawDatabase>;

const CURRENT_SCHEMA_VERSION = 6;
const SCHEMA_VERSION_KEY = 'plugin:tracking:schema_version';

const V3_TIMESTAMP_COLUMNS: ReadonlyArray<{
  table: string;
  columns: readonly string[];
}> = [
  { table: 'tracking_rules', columns: ['last_run_at', 'next_run_at', 'created_at', 'updated_at'] },
  { table: 'tracking_executions', columns: ['started_at', 'finished_at', 'created_at'] },
  { table: 'tracking_items', columns: ['published_at', 'created_at'] },
  { table: 'tracking_logs', columns: ['created_at'] },
  { table: 'interest_entity_links', columns: ['created_at'] },
];

function assertV3TimestampsParseable(rawDb: RawDb): void {
  for (const { table, columns } of V3_TIMESTAMP_COLUMNS) {
    for (const column of columns) {
      const row = rawDb
        .prepare(
          `SELECT rowid, "${column}" AS value
           FROM "${table}"
           WHERE "${column}" IS NOT NULL AND julianday("${column}") IS NULL
           LIMIT 1`,
        )
        .get() as { rowid: number; value: unknown } | undefined;
      if (row) {
        throw new Error(
          `plugins/tracking v3->v4 invalid timestamp in ${table}.${column} ` +
            `(rowid=${row.rowid}, value=${JSON.stringify(row.value)})`,
        );
      }
    }
  }
}

function createV5Tables(rawDb: RawDb): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS tracking_rules (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      name                 TEXT NOT NULL,
      description          TEXT,
      search_queries_json  TEXT NOT NULL CHECK(json_valid(search_queries_json) AND json_type(search_queries_json) = 'array'),
      tool_provider        TEXT,
      interval_minutes     INTEGER NOT NULL DEFAULT 60,
      enabled              INTEGER NOT NULL DEFAULT 1,
      status               TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'executing')),
      last_run_at          INTEGER,
      next_run_at          INTEGER,
      created_at           INTEGER NOT NULL DEFAULT(${NOW_MS_SQL}),
      updated_at           INTEGER NOT NULL DEFAULT(${NOW_MS_SQL}),
      -- P4 deferred resolver: a tracking rule may be created from a chat turn
      -- that references a source still in the pipeline. The classifier flips
      -- enabled=0 and stashes the pending state here until the source reaches
      -- a terminal status; deferredResolver then materializes the rule.
      resolution_status    TEXT NOT NULL DEFAULT 'resolved'
        CHECK(resolution_status IN (
          'resolved', 'pending_pipeline', 'awaiting_clarify',
          'failed_no_entity', 'failed_source_pipeline'
        )),
      pending_resolution   TEXT
        CHECK(pending_resolution IS NULL OR json_valid(pending_resolution)),
      -- B6 修复：专用列计 awaiting_clarify 进入时刻，避免 clarify-timeout 用
      -- updated_at 时被无关 UPDATE（rename / queries 编辑）重置 24h 时钟。
      awaiting_clarify_since INTEGER,
      -- Cross-column: a rule cannot be enabled while still pending; the
      -- resolver flips status to 'resolved' before re-enabling.
      CHECK(resolution_status = 'resolved' OR enabled = 0)
    );

    CREATE TABLE IF NOT EXISTS tracking_executions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id          INTEGER NOT NULL REFERENCES tracking_rules(id) ON DELETE CASCADE,
      started_at       INTEGER NOT NULL,
      finished_at      INTEGER,
      status           TEXT NOT NULL CHECK(status IN ('running', 'done', 'error')),
      items_found      INTEGER DEFAULT 0,
      items_submitted  INTEGER DEFAULT 0,
      error_message    TEXT,
      created_at       INTEGER NOT NULL DEFAULT(${NOW_MS_SQL})
    );

    CREATE TABLE IF NOT EXISTS tracking_items (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id          INTEGER NOT NULL REFERENCES tracking_rules(id) ON DELETE CASCADE,
      execution_id     INTEGER REFERENCES tracking_executions(id) ON DELETE SET NULL,
      url              TEXT NOT NULL,
      title            TEXT,
      snippet          TEXT,
      published_at     INTEGER,
      status           TEXT NOT NULL CHECK(status IN ('found', 'submitted', 'duplicate', 'failed')),
      source_id        INTEGER,
      created_at       INTEGER NOT NULL DEFAULT(${NOW_MS_SQL})
    );

    CREATE TABLE IF NOT EXISTS tracking_logs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id          INTEGER REFERENCES tracking_rules(id) ON DELETE CASCADE,
      execution_id     INTEGER REFERENCES tracking_executions(id) ON DELETE CASCADE,
      level            TEXT NOT NULL CHECK(level IN ('info', 'warn', 'error')),
      message          TEXT NOT NULL,
      created_at       INTEGER NOT NULL DEFAULT(${NOW_MS_SQL})
    );

    CREATE TABLE IF NOT EXISTS interest_entity_links (
      interest_id      INTEGER NOT NULL REFERENCES tracking_rules(id) ON DELETE CASCADE,
      entity_id        INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      created_at       INTEGER NOT NULL DEFAULT(${NOW_MS_SQL}),
      PRIMARY KEY (interest_id, entity_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_items_exec_url ON tracking_items(execution_id, url);
    CREATE INDEX IF NOT EXISTS idx_tracking_items_rule_url ON tracking_items(rule_id, url);
    CREATE INDEX IF NOT EXISTS idx_tracking_items_execution ON tracking_items(execution_id);
    CREATE INDEX IF NOT EXISTS idx_tracking_executions_rule ON tracking_executions(rule_id);
    -- Covers single-rule lookups (e.g. getInterestExecutions, the
    -- inspector's recentExecutions fetch) and lets the planner narrow the
    -- sparkline window scan in getInterestListStats once execution
    -- history grows. The cross-rule GROUP BYs there still scan the index
    -- rather than the heap because the leading column matches.
    CREATE INDEX IF NOT EXISTS idx_tracking_executions_rule_started ON tracking_executions(rule_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_tracking_rules_schedule ON tracking_rules(enabled, status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_tracking_logs_execution ON tracking_logs(execution_id);
    CREATE INDEX IF NOT EXISTS idx_interest_entity_links_entity ON interest_entity_links(entity_id);
    -- P4 deferred resolver lookup: reverse from sourceId stashed in
    -- pending_resolution JSON back to the waiting rule.
    CREATE INDEX IF NOT EXISTS idx_tracking_pending_source
      ON tracking_rules(json_extract(pending_resolution, '$.sourceId'))
      WHERE pending_resolution IS NOT NULL;
  `);
}

function migrateV1ToV2(rawDb: RawDb): void {
  const fkWas = rawDb.pragma('foreign_keys', { simple: true }) as number;
  rawDb.pragma('foreign_keys = OFF');
  try {
    rawDb
      .transaction(() => {
        rawDb.exec(`
          CREATE TABLE tracking_rules_new (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            name                 TEXT NOT NULL,
            description          TEXT,
            search_queries_json  TEXT NOT NULL CHECK(json_valid(search_queries_json) AND json_type(search_queries_json) = 'array'),
            tool_provider        TEXT,
            interval_minutes     INTEGER NOT NULL DEFAULT 60,
            enabled              INTEGER NOT NULL DEFAULT 1,
            status               TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'executing')),
            last_run_at          TEXT,
            next_run_at          TEXT,
            created_at           TEXT NOT NULL DEFAULT(datetime('now')),
            updated_at           TEXT NOT NULL DEFAULT(datetime('now'))
          );
          INSERT INTO tracking_rules_new (id, name, description, search_queries_json, tool_provider, interval_minutes, enabled, status, last_run_at, next_run_at, created_at, updated_at)
          SELECT
            id, name,
            NULL,
            CASE
              WHEN json_extract(config, '$.searchQuery') IS NOT NULL
                   AND TRIM(json_extract(config, '$.searchQuery')) <> ''
                THEN json_array(json_extract(config, '$.searchQuery'))
              ELSE COALESCE(json_extract(config, '$.keywords'), json_array())
            END,
            tool_provider, interval_minutes, enabled, status, last_run_at, next_run_at, created_at, updated_at
          FROM tracking_rules;
          DROP TABLE tracking_rules;
          ALTER TABLE tracking_rules_new RENAME TO tracking_rules;
          CREATE INDEX IF NOT EXISTS idx_tracking_rules_schedule
            ON tracking_rules(enabled, status, next_run_at);
          CREATE TABLE IF NOT EXISTS interest_entity_links (
            interest_id  INTEGER NOT NULL REFERENCES tracking_rules(id) ON DELETE CASCADE,
            entity_id    INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
            created_at   TEXT NOT NULL DEFAULT(datetime('now')),
            PRIMARY KEY (interest_id, entity_id)
          );
          CREATE INDEX IF NOT EXISTS idx_interest_entity_links_entity
            ON interest_entity_links(entity_id);
        `);

        const dangling = rawDb.prepare(`PRAGMA foreign_key_check`).all();
        if (dangling.length > 0) {
          throw new Error(`v1→v2 migration FK check failed: ${JSON.stringify(dangling)}`);
        }

        rawDb
          .prepare(
            `INSERT INTO db_metadata (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(SCHEMA_VERSION_KEY, '2');
      })
      .immediate();
  } finally {
    if (fkWas === 1) rawDb.pragma('foreign_keys = ON');
  }
}

function migrateV2ToV3(rawDb: RawDb): void {
  // v3 only adds an idempotent index. The CREATE INDEX in createV4Tables
  // was added after v2 shipped, so any install that stamped schema_version=2
  // before that change is missing it. Run as a single transaction so the
  // version bump and the DDL are atomic.
  rawDb
    .transaction(() => {
      rawDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_tracking_executions_rule_started
          ON tracking_executions(rule_id, started_at);
      `);
      rawDb
        .prepare(
          `INSERT INTO db_metadata (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(SCHEMA_VERSION_KEY, '3');
    })
    .immediate();
}

// v4: convert all TEXT timestamp columns (`YYYY-MM-DD HH:MM:SS` UTC) to
// INTEGER epoch milliseconds. SQLite can't ALTER COLUMN TYPE, so each table
// is rebuilt. Historical TEXT values are parsed via julianday() with the
// Unix epoch JD constant (2440587.5) — accurate to ms.
function migrateV3ToV4(rawDb: RawDb): void {
  const fkWas = rawDb.pragma('foreign_keys', { simple: true }) as number;
  rawDb.pragma('foreign_keys = OFF');
  try {
    assertV3TimestampsParseable(rawDb);
    rawDb
      .transaction(() => {
        rawDb.exec(`
          -- tracking_rules
          CREATE TABLE tracking_rules_new (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            name                 TEXT NOT NULL,
            description          TEXT,
            search_queries_json  TEXT NOT NULL CHECK(json_valid(search_queries_json) AND json_type(search_queries_json) = 'array'),
            tool_provider        TEXT,
            interval_minutes     INTEGER NOT NULL DEFAULT 60,
            enabled              INTEGER NOT NULL DEFAULT 1,
            status               TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'executing')),
            last_run_at          INTEGER,
            next_run_at          INTEGER,
            created_at           INTEGER NOT NULL DEFAULT(${NOW_MS_SQL}),
            updated_at           INTEGER NOT NULL DEFAULT(${NOW_MS_SQL})
          );
          INSERT INTO tracking_rules_new
            (id, name, description, search_queries_json, tool_provider, interval_minutes, enabled, status, last_run_at, next_run_at, created_at, updated_at)
          SELECT
            id, name, description, search_queries_json, tool_provider, interval_minutes, enabled, status,
            CASE WHEN last_run_at IS NULL THEN NULL ELSE CAST(ROUND((julianday(last_run_at) - 2440587.5) * 86400000) AS INTEGER) END,
            CASE WHEN next_run_at IS NULL THEN NULL ELSE CAST(ROUND((julianday(next_run_at) - 2440587.5) * 86400000) AS INTEGER) END,
            CAST(ROUND((julianday(created_at) - 2440587.5) * 86400000) AS INTEGER),
            CAST(ROUND((julianday(updated_at) - 2440587.5) * 86400000) AS INTEGER)
          FROM tracking_rules;
          DROP TABLE tracking_rules;
          ALTER TABLE tracking_rules_new RENAME TO tracking_rules;

          -- tracking_executions
          CREATE TABLE tracking_executions_new (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id          INTEGER NOT NULL REFERENCES tracking_rules(id) ON DELETE CASCADE,
            started_at       INTEGER NOT NULL,
            finished_at      INTEGER,
            status           TEXT NOT NULL CHECK(status IN ('running', 'done', 'error')),
            items_found      INTEGER DEFAULT 0,
            items_submitted  INTEGER DEFAULT 0,
            error_message    TEXT,
            created_at       INTEGER NOT NULL DEFAULT(${NOW_MS_SQL})
          );
          INSERT INTO tracking_executions_new
            (id, rule_id, started_at, finished_at, status, items_found, items_submitted, error_message, created_at)
          SELECT
            id, rule_id,
            CAST(ROUND((julianday(started_at) - 2440587.5) * 86400000) AS INTEGER),
            CASE WHEN finished_at IS NULL THEN NULL ELSE CAST(ROUND((julianday(finished_at) - 2440587.5) * 86400000) AS INTEGER) END,
            status, items_found, items_submitted, error_message,
            CAST(ROUND((julianday(created_at) - 2440587.5) * 86400000) AS INTEGER)
          FROM tracking_executions;
          DROP TABLE tracking_executions;
          ALTER TABLE tracking_executions_new RENAME TO tracking_executions;

          -- tracking_items
          CREATE TABLE tracking_items_new (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id          INTEGER NOT NULL REFERENCES tracking_rules(id) ON DELETE CASCADE,
            execution_id     INTEGER REFERENCES tracking_executions(id) ON DELETE SET NULL,
            url              TEXT NOT NULL,
            title            TEXT,
            snippet          TEXT,
            published_at     INTEGER,
            status           TEXT NOT NULL CHECK(status IN ('found', 'submitted', 'duplicate', 'failed')),
            source_id        INTEGER,
            created_at       INTEGER NOT NULL DEFAULT(${NOW_MS_SQL})
          );
          INSERT INTO tracking_items_new
            (id, rule_id, execution_id, url, title, snippet, published_at, status, source_id, created_at)
          SELECT
            id, rule_id, execution_id, url, title, snippet,
            CASE WHEN published_at IS NULL THEN NULL ELSE CAST(ROUND((julianday(published_at) - 2440587.5) * 86400000) AS INTEGER) END,
            status, source_id,
            CAST(ROUND((julianday(created_at) - 2440587.5) * 86400000) AS INTEGER)
          FROM tracking_items;
          DROP TABLE tracking_items;
          ALTER TABLE tracking_items_new RENAME TO tracking_items;

          -- tracking_logs
          CREATE TABLE tracking_logs_new (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id          INTEGER REFERENCES tracking_rules(id) ON DELETE CASCADE,
            execution_id     INTEGER REFERENCES tracking_executions(id) ON DELETE CASCADE,
            level            TEXT NOT NULL CHECK(level IN ('info', 'warn', 'error')),
            message          TEXT NOT NULL,
            created_at       INTEGER NOT NULL DEFAULT(${NOW_MS_SQL})
          );
          INSERT INTO tracking_logs_new
            (id, rule_id, execution_id, level, message, created_at)
          SELECT
            id, rule_id, execution_id, level, message,
            CAST(ROUND((julianday(created_at) - 2440587.5) * 86400000) AS INTEGER)
          FROM tracking_logs;
          DROP TABLE tracking_logs;
          ALTER TABLE tracking_logs_new RENAME TO tracking_logs;

          -- interest_entity_links
          CREATE TABLE interest_entity_links_new (
            interest_id      INTEGER NOT NULL REFERENCES tracking_rules(id) ON DELETE CASCADE,
            entity_id        INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
            created_at       INTEGER NOT NULL DEFAULT(${NOW_MS_SQL}),
            PRIMARY KEY (interest_id, entity_id)
          );
          INSERT INTO interest_entity_links_new (interest_id, entity_id, created_at)
          SELECT interest_id, entity_id,
            CAST(ROUND((julianday(created_at) - 2440587.5) * 86400000) AS INTEGER)
          FROM interest_entity_links;
          DROP TABLE interest_entity_links;
          ALTER TABLE interest_entity_links_new RENAME TO interest_entity_links;

          -- Rebuild indexes
          CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_items_exec_url ON tracking_items(execution_id, url);
          CREATE INDEX IF NOT EXISTS idx_tracking_items_rule_url ON tracking_items(rule_id, url);
          CREATE INDEX IF NOT EXISTS idx_tracking_items_execution ON tracking_items(execution_id);
          CREATE INDEX IF NOT EXISTS idx_tracking_executions_rule ON tracking_executions(rule_id);
          CREATE INDEX IF NOT EXISTS idx_tracking_executions_rule_started ON tracking_executions(rule_id, started_at);
          CREATE INDEX IF NOT EXISTS idx_tracking_rules_schedule ON tracking_rules(enabled, status, next_run_at);
          CREATE INDEX IF NOT EXISTS idx_tracking_logs_execution ON tracking_logs(execution_id);
          CREATE INDEX IF NOT EXISTS idx_interest_entity_links_entity ON interest_entity_links(entity_id);
        `);

        const dangling = rawDb.prepare(`PRAGMA foreign_key_check`).all();
        if (dangling.length > 0) {
          throw new Error(`v3→v4 migration FK check failed: ${JSON.stringify(dangling)}`);
        }

        rawDb
          .prepare(
            `INSERT INTO db_metadata (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(SCHEMA_VERSION_KEY, '4');
      })
      .immediate();
  } finally {
    if (fkWas === 1) rawDb.pragma('foreign_keys = ON');
  }
}

// B6: 加 awaiting_clarify_since 列 + backfill 历史 awaiting_clarify 行。
// 如果不 backfill，老行 awaiting_clarify_since=NULL → service.ts 的
// COALESCE fallback 回 updated_at → updateInterest 仍会重置 24h timer，
// B6 修复对历史数据无效。这里在同事务内把它们的 awaiting_clarify_since
// 钉死为现有 updated_at（"现在起 timer 从这一刻算"）。
function migrateV5ToV6(rawDb: RawDb): void {
  rawDb
    .transaction(() => {
      rawDb.exec(`
        ALTER TABLE tracking_rules ADD COLUMN awaiting_clarify_since INTEGER;
        UPDATE tracking_rules
          SET awaiting_clarify_since = updated_at
          WHERE resolution_status = 'awaiting_clarify'
            AND awaiting_clarify_since IS NULL;
      `);
      rawDb
        .prepare(
          `INSERT INTO db_metadata (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(SCHEMA_VERSION_KEY, String(CURRENT_SCHEMA_VERSION));
    })
    .immediate();
}

function migrateV4ToV5(rawDb: RawDb): void {
  const fkWas = rawDb.pragma('foreign_keys', { simple: true }) as number;
  rawDb.pragma('foreign_keys = OFF');
  try {
    rawDb
      .transaction(() => {
        rawDb.exec(`
          CREATE TABLE tracking_rules_new (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            name                 TEXT NOT NULL,
            description          TEXT,
            search_queries_json  TEXT NOT NULL CHECK(json_valid(search_queries_json) AND json_type(search_queries_json) = 'array'),
            tool_provider        TEXT,
            interval_minutes     INTEGER NOT NULL DEFAULT 60,
            enabled              INTEGER NOT NULL DEFAULT 1,
            status               TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'executing')),
            last_run_at          INTEGER,
            next_run_at          INTEGER,
            created_at           INTEGER NOT NULL DEFAULT(${NOW_MS_SQL}),
            updated_at           INTEGER NOT NULL DEFAULT(${NOW_MS_SQL}),
            resolution_status    TEXT NOT NULL DEFAULT 'resolved'
              CHECK(resolution_status IN (
                'resolved', 'pending_pipeline', 'awaiting_clarify',
                'failed_no_entity', 'failed_source_pipeline'
              )),
            pending_resolution   TEXT
              CHECK(pending_resolution IS NULL OR json_valid(pending_resolution)),
            CHECK(resolution_status = 'resolved' OR enabled = 0)
          );
          INSERT INTO tracking_rules_new
            (id, name, description, search_queries_json, tool_provider,
             interval_minutes, enabled, status, last_run_at, next_run_at,
             created_at, updated_at)
          SELECT id, name, description, search_queries_json, tool_provider,
                 interval_minutes, enabled, status, last_run_at, next_run_at,
                 created_at, updated_at
          FROM tracking_rules;
          DROP TABLE tracking_rules;
          ALTER TABLE tracking_rules_new RENAME TO tracking_rules;
          CREATE INDEX IF NOT EXISTS idx_tracking_rules_schedule
            ON tracking_rules(enabled, status, next_run_at);
          CREATE INDEX IF NOT EXISTS idx_tracking_pending_source
            ON tracking_rules(json_extract(pending_resolution, '$.sourceId'))
            WHERE pending_resolution IS NOT NULL;
        `);

        const dangling = rawDb.prepare(`PRAGMA foreign_key_check`).all();
        if (dangling.length > 0) {
          throw new Error(`v4→v5 migration FK check failed: ${JSON.stringify(dangling)}`);
        }

        rawDb
          .prepare(
            `INSERT INTO db_metadata (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(SCHEMA_VERSION_KEY, String(CURRENT_SCHEMA_VERSION));
      })
      .immediate();
  } finally {
    if (fkWas === 1) rawDb.pragma('foreign_keys = ON');
  }
}

export function ensureTrackingTables(db: DrizzleDB): void {
  const rawDb = getRawDatabase(db);

  const row = rawDb
    .prepare(`SELECT value FROM db_metadata WHERE key = ?`)
    .get(SCHEMA_VERSION_KEY) as { value: string } | undefined;
  const currentVersion = row ? Number.parseInt(row.value, 10) : 0;

  if (currentVersion >= CURRENT_SCHEMA_VERSION) return;

  if (currentVersion === 0) {
    rawDb
      .transaction(() => {
        createV5Tables(rawDb);
        rawDb
          .prepare(
            `INSERT INTO db_metadata (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(SCHEMA_VERSION_KEY, String(CURRENT_SCHEMA_VERSION));
      })
      .immediate();
    return;
  }

  if (currentVersion === 1) {
    migrateV1ToV2(rawDb);
    migrateV2ToV3(rawDb);
    migrateV3ToV4(rawDb);
    migrateV4ToV5(rawDb);
    migrateV5ToV6(rawDb);
    return;
  }

  if (currentVersion === 2) {
    migrateV2ToV3(rawDb);
    migrateV3ToV4(rawDb);
    migrateV4ToV5(rawDb);
    migrateV5ToV6(rawDb);
    return;
  }

  if (currentVersion === 3) {
    migrateV3ToV4(rawDb);
    migrateV4ToV5(rawDb);
    migrateV5ToV6(rawDb);
    return;
  }

  if (currentVersion === 4) {
    migrateV4ToV5(rawDb);
    migrateV5ToV6(rawDb);
    return;
  }

  if (currentVersion === 5) {
    migrateV5ToV6(rawDb);
    return;
  }

  throw new Error(
    `plugins/tracking: unexpected schema version ${currentVersion}, cannot migrate to v${CURRENT_SCHEMA_VERSION}`,
  );
}

/**
 * Insert a tracking_rules row that may carry `resolution_status != 'resolved'`
 * + `enabled = 0` + optional `pending_resolution` JSON, in a single atomic
 * transaction with the `interest_entity_links` rows (if any). Used by
 * `TrackingCrudService.createInterestWithResolution` — distinct from
 * `createInterest` because the latter must keep `resolution_status='resolved'`
 * to land an immediately-schedulable rule.
 *
 * Returns `{id, name}` (not the full Interest row) — the create_tracking
 * handler only needs the id for the IntentPluginResult.
 *
 * NOTE: the table CHECK constraint enforces `resolution_status='resolved' OR
 * enabled=0`; passing `enabled=true` + non-resolved status will fail with
 * SQLITE_CONSTRAINT (intentional — surfaces classifier/handler bugs early
 * rather than landing inconsistent rows).
 */
export function insertPendingTrackingRule(
  db: DrizzleDB,
  input: CreateInterestWithResolutionInput,
): { id: number; name: string } {
  const rawDb = getRawDatabase(db);
  return rawDb
    .transaction(() => {
      const result = rawDb
        .prepare(
          `INSERT INTO tracking_rules
             (name, description, search_queries_json, tool_provider, interval_minutes,
              enabled, status, resolution_status, pending_resolution, next_run_at)
           VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?, ${NOW_MS_SQL})`,
        )
        .run(
          input.name,
          input.description ?? null,
          JSON.stringify(input.searchQueries),
          input.toolProvider ?? null,
          input.intervalMinutes ?? 60,
          input.enabled ? 1 : 0,
          input.resolutionStatus,
          input.pendingResolution ? JSON.stringify(input.pendingResolution) : null,
        );
      const id = Number(result.lastInsertRowid);

      // Link entities (when known). The handler passes linkedEntityIds only on
      // the resolved+1-entity branch; pending/awaiting/failed rows leave the
      // junction empty until the deferred resolver fills it in P4.
      if (input.linkedEntityIds && input.linkedEntityIds.length > 0) {
        const deduped = [...new Set(input.linkedEntityIds)];
        const stmt = rawDb.prepare(
          `INSERT INTO interest_entity_links (interest_id, entity_id) VALUES (?, ?)`,
        );
        for (const entityId of deduped) {
          stmt.run(id, entityId);
        }
      }

      return { id, name: input.name };
    })
    .immediate();
}

export function resetCrashedState(db: DrizzleDB): void {
  const rawDb = getRawDatabase(db);
  rawDb
    .transaction(() => {
      rawDb.exec(`
        UPDATE tracking_rules SET status = 'idle' WHERE status = 'executing';
        UPDATE tracking_executions SET status = 'error' WHERE status = 'running';
        UPDATE tracking_items SET status = 'failed'
          WHERE status = 'found'
          AND execution_id IN (SELECT id FROM tracking_executions WHERE status = 'error');
      `);
    })
    .immediate();
}
