// apps/server/tests/deferred-e2e.test.ts
//
// P4 end-to-end: wire the real SqliteSourceRepository.onTerminated hook to
// the real deferredResolver and a hand-rolled DeferredTrackingPort backed by
// raw SQL against the same DB. When `updateStatus(sourceId, terminalStatus)`
// fires, the chain runs synchronously inside the same call stack: pending
// tracking rule → resolved / awaiting_clarify / failed_source_pipeline +
// assistant turn appended + note_entities backfilled.
//
// In-process (not via HTTP) — the goal is to verify wiring, not transport.
// `tracking-resolve.test.ts` already covers the HTTP shape of the clarify
// follow-up path; this test focuses on the upstream pipeline-termination
// trigger that has no HTTP entrypoint (it's a callback fired by the worker).
//
// The tracking_rules schema is replicated inline rather than imported via
// `@goldpan/plugin-tracking` — that plugin is not an apps/server dep (it
// loads dynamically through PluginRegistry at bootstrap), and `package.json`
// only exports `.`. Inlining mirrors the pragmatic choice in
// `tracking-resolve.test.ts`, which also bypasses the plugin to do raw SQL
// against `tracking_rules`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deferred } from '@goldpan/core';
import { createDatabase, type DrizzleDB, getRawDatabase } from '@goldpan/core/db';
import { resolveMigrationsFolder, runMigrations } from '@goldpan/core/db/migrate';
import {
  SqliteConversationRepository,
  SqliteKnowledgeRepository,
  SqliteSourceRepository,
} from '@goldpan/core/db/repositories';
import {
  entities,
  knowledgePoints,
  noteSources,
  notes,
  sourceEntityPoints,
  sources,
} from '@goldpan/core/db/schema';
import { NOW_MS_SQL } from '@goldpan/core/db/sql-fragments';
import { initI18n, resetI18n } from '@goldpan/core/i18n';
import type { ILogObj, Logger } from 'tslog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function silentLogger(): Logger<ILogObj> {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silly: vi.fn(),
    getSubLogger: () => silentLogger(),
  } as unknown as Logger<ILogObj>;
}

// Mirror of the v5 `tracking_rules` shape from plugins/tracking/src/db.ts.
// Kept narrow — only the columns the deferred resolver reads / writes.
// Drift will be caught by tracking-resolve.test.ts (subprocess server with
// the real plugin schema) running in the same suite.
function ensureTrackingRulesTable(rawDb: ReturnType<typeof getRawDatabase>): void {
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
      resolution_status    TEXT NOT NULL DEFAULT 'resolved'
        CHECK(resolution_status IN (
          'resolved', 'pending_pipeline', 'awaiting_clarify',
          'failed_no_entity', 'failed_source_pipeline'
        )),
      pending_resolution   TEXT
        CHECK(pending_resolution IS NULL OR json_valid(pending_resolution)),
      CHECK(resolution_status = 'resolved' OR enabled = 0)
    );
    CREATE TABLE IF NOT EXISTS interest_entity_links (
      interest_id INTEGER NOT NULL REFERENCES tracking_rules(id) ON DELETE CASCADE,
      entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL DEFAULT(${NOW_MS_SQL}),
      PRIMARY KEY (interest_id, entity_id)
    );
  `);
}

// Minimal DeferredTrackingPort backed by the inline tracking_rules schema.
// Mirrors the CAS / JSON-patch logic in plugins/tracking/src/service.ts so
// the resolver exercises the same SQL shape that production runs.
function buildPort(rawDb: ReturnType<typeof getRawDatabase>): deferred.DeferredTrackingPort {
  return {
    findPendingByPipelineSource(sourceId) {
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
          ? (JSON.parse(r.pending_resolution) as deferred.PendingResolutionPayload)
          : null,
      }));
    },
    markResolved(id, input) {
      const result = rawDb
        .prepare(
          `UPDATE tracking_rules
           SET resolution_status = 'resolved', enabled = 1, name = ?,
               search_queries_json = ?, updated_at = ${NOW_MS_SQL}
           WHERE id = ? AND resolution_status = ?`,
        )
        .run(input.name, JSON.stringify(input.searchQueries), id, input.expectedStatus);
      if ((result.changes ?? 0) === 0) return false;
      const linkStmt = rawDb.prepare(
        `INSERT OR IGNORE INTO interest_entity_links (interest_id, entity_id) VALUES (?, ?)`,
      );
      for (const entityId of input.linkedEntityIds) linkStmt.run(id, entityId);
      return true;
    },
    markFailedResolution(id, input) {
      const result = rawDb
        .prepare(
          `UPDATE tracking_rules
           SET resolution_status = ?, enabled = 0, updated_at = ${NOW_MS_SQL}
           WHERE id = ? AND resolution_status = ?`,
        )
        .run(input.targetStatus, id, input.expectedStatus);
      return (result.changes ?? 0) > 0;
    },
    markAwaitingClarify(id, input) {
      const result = rawDb
        .prepare(
          `UPDATE tracking_rules
           SET resolution_status = 'awaiting_clarify', enabled = 0,
               pending_resolution = json_set(
                 COALESCE(pending_resolution, '{}'),
                 '$.candidateEntityIds', json(?)
               ),
               updated_at = ${NOW_MS_SQL}
           WHERE id = ? AND resolution_status = ?`,
        )
        .run(JSON.stringify(input.candidateEntityIds), id, input.expectedStatus);
      return (result.changes ?? 0) > 0;
    },
    findAwaitingClarifyOlderThan() {
      // Not exercised by these scenarios (timeout watcher has its own unit test).
      return [];
    },
  };
}

interface Stack {
  cleanup: () => void;
  sourceRepo: SqliteSourceRepository;
  conversation: SqliteConversationRepository;
  rawDb: ReturnType<typeof getRawDatabase>;
  drizzle: DrizzleDB;
}

function buildStack(): Stack {
  const tmpDir = mkdtempSync(join(tmpdir(), 'deferred-e2e-'));
  const dbPath = join(tmpDir, 'test.db');
  const drizzle = createDatabase(dbPath);
  runMigrations(drizzle, resolveMigrationsFolder());
  const rawDb = getRawDatabase(drizzle);
  ensureTrackingRulesTable(rawDb);

  const knowledge = new SqliteKnowledgeRepository(drizzle);
  const conversation = new SqliteConversationRepository(drizzle);
  const trackingPort = buildPort(rawDb);

  const sourceRepo = new SqliteSourceRepository(drizzle, {
    onSourceTerminated: (sourceId, status) => {
      deferred.onSourceTerminated(sourceId, status, {
        db: drizzle,
        knowledge,
        conversation,
        trackingPort,
        logger: silentLogger(),
      });
    },
  });

  return {
    drizzle,
    rawDb,
    sourceRepo,
    conversation,
    cleanup: () => {
      try {
        rawDb.close();
      } catch {
        /* already closed */
      }
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function seedPendingTrackingRule(
  rawDb: ReturnType<typeof getRawDatabase>,
  args: { sourceId: number; conversationId: number; name?: string },
): number {
  const payload: deferred.PendingResolutionPayload = {
    sourceId: args.sourceId,
    placeholderName: args.name ?? 'placeholder',
    conversationId: args.conversationId,
  };
  const result = rawDb
    .prepare(
      `INSERT INTO tracking_rules
         (name, search_queries_json, enabled, resolution_status, pending_resolution)
       VALUES (?, ?, 0, 'pending_pipeline', ?)`,
    )
    .run(args.name ?? 'placeholder', JSON.stringify(['placeholder']), JSON.stringify(payload));
  return Number(result.lastInsertRowid);
}

describe('P4 deferred resolver E2E — pipeline terminate → tracking + note backfill', () => {
  let stack: Stack;

  beforeEach(() => {
    resetI18n();
    initI18n('zh');
    stack = buildStack();
  });

  afterEach(() => {
    stack.cleanup();
    resetI18n();
  });

  it('confirmed + 1 entity → tracking promote (resolved + enabled) + action assistant turn', () => {
    const [src] = stack.drizzle
      .insert(sources)
      .values({
        kind: 'external',
        normalizedUrl: 'http://e2e/promote',
        originalUrl: 'http://e2e/promote',
        status: 'processing',
      })
      .returning()
      .all();
    const [ent] = stack.drizzle.insert(entities).values({ name: 'Anthropic' }).returning().all();
    const [kp] = stack.drizzle
      .insert(knowledgePoints)
      .values({ content: 'p', type: 'fact' })
      .returning()
      .all();
    stack.drizzle
      .insert(sourceEntityPoints)
      .values({ sourceId: src.id, entityId: ent.id, pointId: kp.id, judgment: 'new' })
      .run();

    const { id: convId } = stack.conversation.findOrCreate('web:e2e:promote', 'web');
    const ruleId = seedPendingTrackingRule(stack.rawDb, {
      sourceId: src.id,
      conversationId: convId,
    });

    stack.sourceRepo.updateStatus(src.id, 'confirmed');

    const row = stack.rawDb
      .prepare('SELECT resolution_status, enabled, name FROM tracking_rules WHERE id = ?')
      .get(ruleId) as { resolution_status: string; enabled: number; name: string };
    expect(row.resolution_status).toBe('resolved');
    expect(row.enabled).toBe(1);
    expect(row.name).toBe('Anthropic');

    const link = stack.rawDb
      .prepare('SELECT entity_id FROM interest_entity_links WHERE interest_id = ?')
      .get(ruleId) as { entity_id: number } | undefined;
    expect(link?.entity_id).toBe(ent.id);

    const last = stack.conversation.loadContext('web:e2e:promote', 6)?.recentMessages.at(-1);
    expect(last?.role).toBe('assistant');
    expect((last?.metadata as Record<string, unknown>)?.resultType).toBe('action');
    expect((last?.metadata as Record<string, unknown>)?.trackingRuleId).toBe(ruleId);
  });

  it('confirmed + 2 entities → awaiting_clarify + clarify turn with structuredOptions', () => {
    const [src] = stack.drizzle
      .insert(sources)
      .values({
        kind: 'external',
        normalizedUrl: 'http://e2e/clarify',
        originalUrl: 'http://e2e/clarify',
        status: 'processing',
      })
      .returning()
      .all();
    const [e1] = stack.drizzle.insert(entities).values({ name: 'OptionA' }).returning().all();
    const [e2] = stack.drizzle.insert(entities).values({ name: 'OptionB' }).returning().all();
    const [kp] = stack.drizzle
      .insert(knowledgePoints)
      .values({ content: 'p', type: 'fact' })
      .returning()
      .all();
    stack.drizzle
      .insert(sourceEntityPoints)
      .values([
        { sourceId: src.id, entityId: e1.id, pointId: kp.id, judgment: 'new' },
        { sourceId: src.id, entityId: e2.id, pointId: kp.id, judgment: 'new' },
      ])
      .run();

    const { id: convId } = stack.conversation.findOrCreate('web:e2e:clarify', 'web');
    const ruleId = seedPendingTrackingRule(stack.rawDb, {
      sourceId: src.id,
      conversationId: convId,
    });

    stack.sourceRepo.updateStatus(src.id, 'confirmed');

    const row = stack.rawDb
      .prepare(
        'SELECT resolution_status, enabled, pending_resolution FROM tracking_rules WHERE id = ?',
      )
      .get(ruleId) as {
      resolution_status: string;
      enabled: number;
      pending_resolution: string | null;
    };
    expect(row.resolution_status).toBe('awaiting_clarify');
    expect(row.enabled).toBe(0);
    const pending = row.pending_resolution ? JSON.parse(row.pending_resolution) : {};
    expect([...(pending.candidateEntityIds as number[])].sort()).toEqual([e1.id, e2.id].sort());

    const last = stack.conversation.loadContext('web:e2e:clarify', 6)?.recentMessages.at(-1);
    expect((last?.metadata as Record<string, unknown>)?.resultType).toBe('clarify');
    const opts = (last?.metadata as Record<string, unknown>)?.structuredOptions as Array<{
      intentKey: string;
      payload: string;
    }>;
    expect(opts).toHaveLength(2);
    expect(opts[0].intentKey).toBe('resolve_tracking_entity');
    // payload carries trackingRuleId so the UI chip → POST /tracking/rules/:id/resolve
    // round-trip can reach the same rule without re-deriving it from the message.
    const parsed = JSON.parse(opts[0].payload) as { trackingRuleId: number; entityId: number };
    expect(parsed.trackingRuleId).toBe(ruleId);
    expect([e1.id, e2.id]).toContain(parsed.entityId);
  });

  it('failed pipeline → failed_source_pipeline + action turn', () => {
    const [src] = stack.drizzle
      .insert(sources)
      .values({
        kind: 'external',
        normalizedUrl: 'http://e2e/fail',
        originalUrl: 'http://e2e/fail',
        status: 'processing',
      })
      .returning()
      .all();
    const { id: convId } = stack.conversation.findOrCreate('web:e2e:fail', 'web');
    const ruleId = seedPendingTrackingRule(stack.rawDb, {
      sourceId: src.id,
      conversationId: convId,
    });

    stack.sourceRepo.updateStatus(src.id, 'failed');

    const row = stack.rawDb
      .prepare('SELECT resolution_status, enabled FROM tracking_rules WHERE id = ?')
      .get(ruleId) as { resolution_status: string; enabled: number };
    expect(row.resolution_status).toBe('failed_source_pipeline');
    expect(row.enabled).toBe(0);

    const last = stack.conversation.loadContext('web:e2e:fail', 6)?.recentMessages.at(-1);
    expect((last?.metadata as Record<string, unknown>)?.resultType).toBe('action');
    expect((last?.metadata as Record<string, unknown>)?.trackingRuleId).toBe(ruleId);
  });

  it('note linkedSource → confirmed + 1 entity → note_entities 回填', () => {
    const [src] = stack.drizzle
      .insert(sources)
      .values({
        kind: 'external',
        normalizedUrl: 'http://e2e/note',
        originalUrl: 'http://e2e/note',
        status: 'processing',
      })
      .returning()
      .all();
    const [ent] = stack.drizzle.insert(entities).values({ name: 'NoteEntity' }).returning().all();
    const [kp] = stack.drizzle
      .insert(knowledgePoints)
      .values({ content: 'p', type: 'fact' })
      .returning()
      .all();
    stack.drizzle
      .insert(sourceEntityPoints)
      .values({ sourceId: src.id, entityId: ent.id, pointId: kp.id, judgment: 'new' })
      .run();

    const [note] = stack.drizzle
      .insert(notes)
      .values({ content: 'observation about it' })
      .returning()
      .all();
    stack.drizzle
      .insert(noteSources)
      .values({ noteId: note.id, sourceId: src.id, relation: 'reference' })
      .run();

    stack.sourceRepo.updateStatus(src.id, 'confirmed');

    const link = stack.rawDb
      .prepare('SELECT entity_id FROM note_entities WHERE note_id = ?')
      .get(note.id) as { entity_id: number } | undefined;
    expect(link?.entity_id).toBe(ent.id);
  });
});
