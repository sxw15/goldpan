import { getRawDatabase } from '@goldpan/core/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDB } from '../../../packages/core/tests/helpers/test-db';
import { ensureTrackingTables, resetCrashedState } from '../src/db';

describe('tracking DB tables', () => {
  let db: any;
  let cleanup: () => void;

  beforeEach(() => {
    const testDb = createTestDB();
    db = testDb.db;
    cleanup = testDb.cleanup;
  });
  afterEach(() => cleanup());

  it('creates tables idempotently', () => {
    ensureTrackingTables(db);
    ensureTrackingTables(db); // second call is no-op
    const rawDb = getRawDatabase(db);
    const tables = rawDb
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'tracking_%' OR name = 'interest_entity_links')`,
      )
      .all();
    expect(tables.map((t: any) => t.name).sort()).toEqual([
      'interest_entity_links',
      'tracking_executions',
      'tracking_items',
      'tracking_logs',
      'tracking_rules',
    ]);
  });

  it('resetCrashedState resets executing rules and running executions', () => {
    ensureTrackingTables(db);
    const rawDb = getRawDatabase(db);
    rawDb
      .prepare(`INSERT INTO tracking_rules (name, search_queries_json, status) VALUES (?, ?, ?)`)
      .run('test', '["test"]', 'executing');
    resetCrashedState(db);
    const rule = rawDb.prepare(`SELECT status FROM tracking_rules WHERE name = ?`).get('test');
    expect((rule as any).status).toBe('idle');
  });
});

describe('tracking db schema migrations', () => {
  let db: any;
  let cleanup: () => void;

  beforeEach(() => {
    const testDb = createTestDB();
    db = testDb.db;
    cleanup = testDb.cleanup;
  });
  afterEach(() => cleanup());

  it('fresh install (v0) produces v6 shape: search_queries_json column, no type/config columns, interest_entity_links table', () => {
    ensureTrackingTables(db);
    const raw = getRawDatabase(db);

    const cols = raw.prepare(`PRAGMA table_info(tracking_rules)`).all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('search_queries_json');
    expect(colNames).toContain('description');
    expect(colNames).not.toContain('config');
    expect(colNames).not.toContain('type');

    const links = raw.prepare(`PRAGMA table_info(interest_entity_links)`).all();
    expect(links.length).toBeGreaterThan(0);

    const version = raw
      .prepare(`SELECT value FROM db_metadata WHERE key = ?`)
      .get('plugin:tracking:schema_version') as { value: string } | undefined;
    expect(version?.value).toBe('6');
  });

  it('v1 → v2 migrates config.keywords into search_queries_json + preserves child rows + cross-plugin FK id stays', () => {
    const raw = getRawDatabase(db);

    // 手造 v1 形状
    raw.exec(`
      CREATE TABLE tracking_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('keyword')),
        config TEXT NOT NULL CHECK(json_valid(config) AND json_type(config) = 'object'),
        tool_provider TEXT,
        interval_minutes INTEGER NOT NULL DEFAULT 60,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','executing')),
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL DEFAULT(datetime('now')),
        updated_at TEXT NOT NULL DEFAULT(datetime('now'))
      );
      CREATE TABLE tracking_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES tracking_rules(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        items_found INTEGER DEFAULT 0,
        items_submitted INTEGER DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT(datetime('now'))
      );
      CREATE TABLE tracking_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES tracking_rules(id) ON DELETE CASCADE,
        execution_id INTEGER REFERENCES tracking_executions(id) ON DELETE SET NULL,
        url TEXT NOT NULL,
        title TEXT,
        snippet TEXT,
        published_at TEXT,
        status TEXT NOT NULL,
        source_id INTEGER,
        created_at TEXT NOT NULL DEFAULT(datetime('now'))
      );
      CREATE TABLE tracking_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER REFERENCES tracking_rules(id) ON DELETE CASCADE,
        execution_id INTEGER REFERENCES tracking_executions(id) ON DELETE CASCADE,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT(datetime('now'))
      );
      INSERT INTO tracking_rules (id, name, type, config, tool_provider, interval_minutes, enabled, status)
        VALUES (1, 'AI News', 'keyword', '{"keywords":["AI","LLM"],"searchQuery":"AI OR LLM"}', NULL, 60, 1, 'idle');
      INSERT INTO tracking_executions (rule_id, started_at, status, items_found, items_submitted)
        VALUES (1, datetime('now'), 'done', 5, 2);
      INSERT INTO tracking_items (rule_id, execution_id, url, status)
        VALUES (1, 1, 'https://example.com/a', 'submitted');
      INSERT INTO tracking_logs (rule_id, execution_id, level, message)
        VALUES (1, 1, 'info', 'seeded');
    `);
    // core sources 表已由 createTestDB 的 migrations 建好
    raw
      .prepare(
        `INSERT INTO sources (id, kind, original_url, normalized_url, status, origin, tracking_rule_id, created_at, updated_at)
         VALUES (?, 'external', 'https://example.com/x', 'https://example.com/x', 'processing', 'tracking', ?, datetime('now'), datetime('now'))`,
      )
      .run(77, 1);
    raw
      .prepare(`INSERT INTO db_metadata (key, value) VALUES (?, ?)`)
      .run('plugin:tracking:schema_version', '1');

    ensureTrackingTables(db);

    const row = raw
      .prepare(`SELECT search_queries_json, description FROM tracking_rules WHERE id = 1`)
      .get() as { search_queries_json: string; description: string | null };
    // v1 config.searchQuery differs from keywords.join(' OR ') (custom spacing
    // and operator placement). The migration must prefer the user-authored
    // searchQuery; otherwise a rule that had a tuned query silently runs a
    // different search after the upgrade.
    expect(JSON.parse(row.search_queries_json)).toEqual(['AI OR LLM']);
    expect(row.description).toBeNull();

    // 子表数据保留
    const execCount = raw
      .prepare(`SELECT COUNT(*) as c FROM tracking_executions WHERE rule_id = 1`)
      .get() as { c: number };
    expect(execCount.c).toBe(1);
    const itemCount = raw
      .prepare(`SELECT COUNT(*) as c FROM tracking_items WHERE rule_id = 1`)
      .get() as { c: number };
    expect(itemCount.c).toBe(1);
    const logCount = raw
      .prepare(`SELECT COUNT(*) as c FROM tracking_logs WHERE rule_id = 1`)
      .get() as { c: number };
    expect(logCount.c).toBe(1);

    // cross-plugin FK id 保持
    const sourceRow = raw.prepare(`SELECT tracking_rule_id FROM sources WHERE id = 77`).get() as {
      tracking_rule_id: number;
    };
    expect(sourceRow.tracking_rule_id).toBe(1);

    // schema_version bumped
    const version = raw
      .prepare(`SELECT value FROM db_metadata WHERE key = ?`)
      .get('plugin:tracking:schema_version') as { value: string };
    expect(version.value).toBe('6');
  });

  it('ensureTrackingTables is idempotent on fresh DB', () => {
    ensureTrackingTables(db);
    // second call should be a no-op (currentVersion >= CURRENT_SCHEMA_VERSION)
    expect(() => ensureTrackingTables(db)).not.toThrow();
    const raw = getRawDatabase(db);
    const version = raw
      .prepare(`SELECT value FROM db_metadata WHERE key = ?`)
      .get('plugin:tracking:schema_version') as { value: string };
    expect(version.value).toBe('6');
  });

  it('v4 → v5 recovery adds resolution columns when metadata is still v4', () => {
    const raw = getRawDatabase(db);
    raw.exec(`
      CREATE TABLE tracking_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        search_queries_json TEXT NOT NULL CHECK(json_valid(search_queries_json) AND json_type(search_queries_json) = 'array'),
        tool_provider TEXT,
        interval_minutes INTEGER NOT NULL DEFAULT 60,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'executing')),
        last_run_at INTEGER,
        next_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO tracking_rules (id, name, search_queries_json, created_at, updated_at)
        VALUES (1, 'v4-rule', '[]', 1000, 1000);
      INSERT INTO db_metadata (key, value) VALUES ('plugin:tracking:schema_version', '4');
    `);

    ensureTrackingTables(db);

    const cols = raw.prepare(`PRAGMA table_info(tracking_rules)`).all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('resolution_status');
    expect(colNames).toContain('pending_resolution');
    const version = raw
      .prepare(`SELECT value FROM db_metadata WHERE key = ?`)
      .get('plugin:tracking:schema_version') as { value: string };
    expect(version.value).toBe('6');
  });

  function seedV3Schema(raw: ReturnType<typeof getRawDatabase>): void {
    raw.exec(`
      CREATE TABLE tracking_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        search_queries_json TEXT NOT NULL CHECK(json_valid(search_queries_json) AND json_type(search_queries_json) = 'array'),
        tool_provider TEXT,
        interval_minutes INTEGER NOT NULL DEFAULT 60,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'executing')),
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL DEFAULT(datetime('now')),
        updated_at TEXT NOT NULL DEFAULT(datetime('now'))
      );
      CREATE TABLE tracking_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES tracking_rules(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('running', 'done', 'error')),
        items_found INTEGER DEFAULT 0,
        items_submitted INTEGER DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT(datetime('now'))
      );
      CREATE TABLE tracking_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES tracking_rules(id) ON DELETE CASCADE,
        execution_id INTEGER REFERENCES tracking_executions(id) ON DELETE SET NULL,
        url TEXT NOT NULL,
        title TEXT,
        snippet TEXT,
        published_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('found', 'submitted', 'duplicate', 'failed')),
        source_id INTEGER,
        created_at TEXT NOT NULL DEFAULT(datetime('now'))
      );
      CREATE TABLE tracking_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER REFERENCES tracking_rules(id) ON DELETE CASCADE,
        execution_id INTEGER REFERENCES tracking_executions(id) ON DELETE CASCADE,
        level TEXT NOT NULL CHECK(level IN ('info', 'warn', 'error')),
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT(datetime('now'))
      );
      CREATE TABLE interest_entity_links (
        interest_id INTEGER NOT NULL REFERENCES tracking_rules(id) ON DELETE CASCADE,
        entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT(datetime('now')),
        PRIMARY KEY (interest_id, entity_id)
      );
      INSERT INTO db_metadata (key, value) VALUES ('plugin:tracking:schema_version', '3');
    `);
  }

  it('v3 → v4 preserves millisecond precision when converting TEXT timestamps', () => {
    const raw = getRawDatabase(db);
    seedV3Schema(raw);
    raw.exec(`
      INSERT INTO tracking_rules (id, name, search_queries_json, created_at, updated_at)
        VALUES (1, 'Precise', '["q"]', '2026-05-12 14:59:40.123', '2026-05-12 14:59:40.001');
      INSERT INTO tracking_executions (id, rule_id, started_at, finished_at, status, created_at)
        VALUES (1, 1, '2026-05-12 14:59:40.123', '2026-05-12 14:59:40.001', 'done', '2026-05-12 14:59:40.999');
      INSERT INTO tracking_items (id, rule_id, execution_id, url, published_at, status, created_at)
        VALUES (1, 1, 1, 'https://example.com/a', '2026-05-12 14:59:40.123', 'found', '2026-05-12 14:59:40.001');
    `);

    ensureTrackingTables(db);

    const rule = raw.prepare(`SELECT created_at, updated_at FROM tracking_rules`).get() as {
      created_at: number;
      updated_at: number;
    };
    const execution = raw
      .prepare(`SELECT started_at, finished_at, created_at FROM tracking_executions`)
      .get() as { started_at: number; finished_at: number; created_at: number };
    const item = raw.prepare(`SELECT published_at, created_at FROM tracking_items`).get() as {
      published_at: number;
      created_at: number;
    };
    expect(rule.created_at).toBe(Date.parse('2026-05-12T14:59:40.123Z'));
    expect(rule.updated_at).toBe(Date.parse('2026-05-12T14:59:40.001Z'));
    expect(execution.started_at).toBe(Date.parse('2026-05-12T14:59:40.123Z'));
    expect(execution.finished_at).toBe(Date.parse('2026-05-12T14:59:40.001Z'));
    expect(execution.created_at).toBe(Date.parse('2026-05-12T14:59:40.999Z'));
    expect(item.published_at).toBe(Date.parse('2026-05-12T14:59:40.123Z'));
    expect(item.created_at).toBe(Date.parse('2026-05-12T14:59:40.001Z'));
  });

  it('v3 → v4 reports the table and column when a required timestamp is invalid', () => {
    const raw = getRawDatabase(db);
    seedV3Schema(raw);
    raw.exec(`
      INSERT INTO tracking_rules (id, name, search_queries_json, created_at, updated_at)
        VALUES (1, 'Bad', '["q"]', 'not-a-date', '2026-05-12 14:59:40');
    `);

    expect(() => ensureTrackingTables(db)).toThrow(/tracking_rules\.created_at/);
  });

  /**
   * The v1→v2 COALESCE(json_extract(config, '$.keywords'), json_array())
   * must produce a valid JSON array for every shape of `config` that v1's
   * CHECK(json_valid(config) AND json_type(config) = 'object') admitted:
   * keywords-missing, keywords-null, keywords-empty-array, and mixed rows.
   * Each variant is tested below against the v2 CHECK(json_type =
   * 'array') so a regression (e.g. dropping COALESCE) would fail the migration.
   */
  function seedV1SchemaWithRules(
    raw: ReturnType<typeof getRawDatabase>,
    rules: Array<{ id: number; name: string; configJson: string }>,
  ): void {
    raw.exec(`
      CREATE TABLE tracking_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('keyword')),
        config TEXT NOT NULL CHECK(json_valid(config) AND json_type(config) = 'object'),
        tool_provider TEXT,
        interval_minutes INTEGER NOT NULL DEFAULT 60,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','executing')),
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL DEFAULT(datetime('now')),
        updated_at TEXT NOT NULL DEFAULT(datetime('now'))
      );
      CREATE TABLE tracking_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES tracking_rules(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        items_found INTEGER DEFAULT 0,
        items_submitted INTEGER DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT(datetime('now'))
      );
      CREATE TABLE tracking_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES tracking_rules(id) ON DELETE CASCADE,
        execution_id INTEGER REFERENCES tracking_executions(id) ON DELETE SET NULL,
        url TEXT NOT NULL,
        title TEXT,
        snippet TEXT,
        published_at TEXT,
        status TEXT NOT NULL,
        source_id INTEGER,
        created_at TEXT NOT NULL DEFAULT(datetime('now'))
      );
      CREATE TABLE tracking_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER REFERENCES tracking_rules(id) ON DELETE CASCADE,
        execution_id INTEGER REFERENCES tracking_executions(id) ON DELETE CASCADE,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT(datetime('now'))
      );
    `);
    for (const r of rules) {
      raw
        .prepare(
          `INSERT INTO tracking_rules (id, name, type, config, interval_minutes, enabled, status)
           VALUES (?, ?, 'keyword', ?, 60, 1, 'idle')`,
        )
        .run(r.id, r.name, r.configJson);
    }
    raw
      .prepare(`INSERT INTO db_metadata (key, value) VALUES (?, ?)`)
      .run('plugin:tracking:schema_version', '1');
  }

  it('v1 → v2 with config missing "keywords" key migrates to empty JSON array', () => {
    const raw = getRawDatabase(db);
    seedV1SchemaWithRules(raw, [{ id: 1, name: 'NoKeywords', configJson: '{}' }]);

    ensureTrackingTables(db);

    const row = raw
      .prepare(`SELECT search_queries_json FROM tracking_rules WHERE id = 1`)
      .get() as { search_queries_json: string };
    expect(JSON.parse(row.search_queries_json)).toEqual([]);
  });

  it('v1 → v2 with config having explicit "keywords": null falls back to empty array', () => {
    const raw = getRawDatabase(db);
    seedV1SchemaWithRules(raw, [{ id: 1, name: 'NullKeywords', configJson: '{"keywords":null}' }]);

    ensureTrackingTables(db);

    const row = raw
      .prepare(`SELECT search_queries_json FROM tracking_rules WHERE id = 1`)
      .get() as { search_queries_json: string };
    expect(JSON.parse(row.search_queries_json)).toEqual([]);
  });

  it('v1 → v2 with config having empty "keywords": [] preserves the empty array', () => {
    const raw = getRawDatabase(db);
    seedV1SchemaWithRules(raw, [{ id: 1, name: 'EmptyKeywords', configJson: '{"keywords":[]}' }]);

    ensureTrackingTables(db);

    const row = raw
      .prepare(`SELECT search_queries_json FROM tracking_rules WHERE id = 1`)
      .get() as { search_queries_json: string };
    expect(JSON.parse(row.search_queries_json)).toEqual([]);
  });

  it('v1 → v2 with mixed config shapes across 4 rules migrates each independently', () => {
    const raw = getRawDatabase(db);
    seedV1SchemaWithRules(raw, [
      { id: 10, name: 'Normal', configJson: '{"keywords":["A","B"]}' },
      { id: 11, name: 'Missing', configJson: '{}' },
      { id: 12, name: 'Null', configJson: '{"keywords":null}' },
      { id: 13, name: 'Empty', configJson: '{"keywords":[]}' },
    ]);

    ensureTrackingTables(db);

    const rows = raw
      .prepare(`SELECT id, search_queries_json FROM tracking_rules ORDER BY id`)
      .all() as Array<{ id: number; search_queries_json: string }>;
    expect(rows).toHaveLength(4);
    expect(JSON.parse(rows[0].search_queries_json)).toEqual(['A', 'B']);
    expect(JSON.parse(rows[1].search_queries_json)).toEqual([]);
    expect(JSON.parse(rows[2].search_queries_json)).toEqual([]);
    expect(JSON.parse(rows[3].search_queries_json)).toEqual([]);

    const version = raw
      .prepare(`SELECT value FROM db_metadata WHERE key = ?`)
      .get('plugin:tracking:schema_version') as { value: string };
    expect(version.value).toBe('6');
  });

  it('v1 → v2 preserves non-empty config.searchQuery distinct from keywords.join', () => {
    const raw = getRawDatabase(db);
    seedV1SchemaWithRules(raw, [
      {
        id: 1,
        name: 'Custom',
        // searchQuery uses boolean operators that would differ from the naive
        // keywords.join(' OR '), proving the migration selects searchQuery
        // rather than silently reconstructing one from keywords.
        configJson: '{"keywords":["AI","ML"],"searchQuery":"(AI OR ML) AND agent"}',
      },
    ]);

    ensureTrackingTables(db);

    const row = raw
      .prepare(`SELECT search_queries_json FROM tracking_rules WHERE id = 1`)
      .get() as { search_queries_json: string };
    expect(JSON.parse(row.search_queries_json)).toEqual(['(AI OR ML) AND agent']);
  });

  it('v1 → v2 with empty-string searchQuery falls back to keywords', () => {
    const raw = getRawDatabase(db);
    seedV1SchemaWithRules(raw, [
      {
        id: 1,
        name: 'BlankQuery',
        // Whitespace-only searchQuery should not clobber a populated keywords
        // list — the TRIM guard in the migration CASE picks keywords instead.
        configJson: '{"keywords":["X","Y"],"searchQuery":"   "}',
      },
    ]);

    ensureTrackingTables(db);

    const row = raw
      .prepare(`SELECT search_queries_json FROM tracking_rules WHERE id = 1`)
      .get() as { search_queries_json: string };
    expect(JSON.parse(row.search_queries_json)).toEqual(['X', 'Y']);
  });
});

describe('tracking_rules resolution_status / pending_resolution (P4 准备)', () => {
  let db: any;
  let cleanup: () => void;

  beforeEach(() => {
    const testDb = createTestDB();
    db = testDb.db;
    cleanup = testDb.cleanup;
    ensureTrackingTables(db);
  });
  afterEach(() => cleanup());

  it('resolution_status defaults to "resolved" for new rules', () => {
    const raw = getRawDatabase(db);
    raw.prepare(`INSERT INTO tracking_rules (name, search_queries_json) VALUES ('r1', '[]')`).run();
    const row = raw
      .prepare(`SELECT resolution_status, pending_resolution FROM tracking_rules WHERE name = 'r1'`)
      .get() as { resolution_status: string; pending_resolution: string | null };
    expect(row.resolution_status).toBe('resolved');
    expect(row.pending_resolution).toBeNull();
  });

  it('rejects enabled=1 with non-resolved resolution_status (cross-column CHECK)', () => {
    const raw = getRawDatabase(db);
    expect(() => {
      raw
        .prepare(
          `INSERT INTO tracking_rules (name, search_queries_json, enabled, resolution_status)
           VALUES ('bad', '[]', 1, 'pending_pipeline')`,
        )
        .run();
    }).toThrow(/CHECK constraint/);
  });

  it('allows enabled=0 with non-resolved resolution_status', () => {
    const raw = getRawDatabase(db);
    raw
      .prepare(
        `INSERT INTO tracking_rules (name, search_queries_json, enabled, resolution_status, pending_resolution)
         VALUES ('ok', '[]', 0, 'pending_pipeline', '{"sourceId":42}')`,
      )
      .run();
    const row = raw
      .prepare(
        `SELECT enabled, resolution_status, pending_resolution FROM tracking_rules WHERE name = 'ok'`,
      )
      .get() as { enabled: number; resolution_status: string; pending_resolution: string };
    expect(row.enabled).toBe(0);
    expect(row.resolution_status).toBe('pending_pipeline');
    expect(JSON.parse(row.pending_resolution)).toEqual({ sourceId: 42 });
  });

  it('rejects non-enum resolution_status', () => {
    const raw = getRawDatabase(db);
    expect(() => {
      raw
        .prepare(
          `INSERT INTO tracking_rules (name, search_queries_json, enabled, resolution_status)
           VALUES ('x', '[]', 0, 'bogus')`,
        )
        .run();
    }).toThrow(/CHECK constraint/);
  });

  it('rejects invalid JSON in pending_resolution', () => {
    const raw = getRawDatabase(db);
    expect(() => {
      raw
        .prepare(
          `INSERT INTO tracking_rules (name, search_queries_json, enabled, resolution_status, pending_resolution)
           VALUES ('bad-json', '[]', 0, 'pending_pipeline', 'not-json')`,
        )
        .run();
    }).toThrow(/CHECK constraint/);
  });

  it('idx_tracking_pending_source is queryable by JSON sourceId', () => {
    const raw = getRawDatabase(db);
    raw
      .prepare(
        `INSERT INTO tracking_rules (name, search_queries_json, enabled, resolution_status, pending_resolution)
         VALUES ('pending1', '[]', 0, 'pending_pipeline', '{"sourceId":99,"intent":"track"}'),
                ('pending2', '[]', 0, 'pending_pipeline', '{"sourceId":99,"intent":"clarify"}'),
                ('other',    '[]', 0, 'pending_pipeline', '{"sourceId":100}')`,
      )
      .run();
    const rows = raw
      .prepare(
        `SELECT name FROM tracking_rules
         WHERE json_extract(pending_resolution, '$.sourceId') = ?`,
      )
      .all(99) as Array<{ name: string }>;
    expect(rows.map((r) => r.name).sort()).toEqual(['pending1', 'pending2']);
  });
});
