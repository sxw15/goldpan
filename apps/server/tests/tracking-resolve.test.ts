// apps/server/tests/tracking-resolve.test.ts
//
// Integration test for `POST /tracking/rules/:id/resolve` — the UI clarify-chip
// path that flips an `awaiting_clarify` rule to `resolved` after the user picks
// one entity from the candidate list.
//
// We use the same subprocess pattern as routes/tracking.test.ts and seed the
// rule + entity + conversation rows via a second WAL-mode SQLite connection.
// Raw SQL is required because (a) there is no public POST that creates a
// `resolution_status='awaiting_clarify'` rule — only the create_tracking
// handler + the deferredResolver flip rows into that state — and (b) the
// `entities` table has no public POST either (pipeline owns entity creation).
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request, type StartedServer, startTestServer } from './helpers';

describe('POST /tracking/rules/:id/resolve', () => {
  let server: StartedServer;
  let seedDb: Database.Database;

  beforeEach(async () => {
    server = await startTestServer();
    seedDb = new Database(path.join(server.tmpDir, 'test.db'));
  }, 60_000);

  afterEach(async () => {
    seedDb?.close();
    await server?.stop();
  });

  const authHeaders = () => ({ Authorization: `Bearer ${server.password}` });

  /** Insert N entities and return their ids. */
  function seedEntities(count: number): number[] {
    const ids: number[] = [];
    const stmt = seedDb.prepare(
      `INSERT INTO entities (name, description, aliases, keywords)
       VALUES (?, ?, '[]', '[]')`,
    );
    for (let i = 0; i < count; i++) {
      const res = stmt.run(`Candidate ${i}`, 'seeded');
      ids.push(Number(res.lastInsertRowid));
    }
    return ids;
  }

  /**
   * Insert a `tracking_rules` row directly (no public POST creates an
   * `awaiting_clarify` row). Returns the rule id.
   */
  function seedAwaitingClarifyRule(args: {
    candidateEntityIds: number[];
    conversationId: number;
  }): number {
    const payload = {
      sourceId: 0,
      candidateEntityIds: args.candidateEntityIds,
      conversationId: args.conversationId,
    };
    const result = seedDb
      .prepare(
        `INSERT INTO tracking_rules
           (name, search_queries_json, enabled, resolution_status, pending_resolution)
         VALUES (?, ?, 0, 'awaiting_clarify', ?)`,
      )
      .run('placeholder', JSON.stringify(['placeholder']), JSON.stringify(payload));
    return Number(result.lastInsertRowid);
  }

  /** Resolved rule, used to assert the 409 conflict branch. */
  function seedResolvedRule(args: { conversationId: number }): number {
    const payload = { sourceId: 0, conversationId: args.conversationId };
    const result = seedDb
      .prepare(
        `INSERT INTO tracking_rules
           (name, search_queries_json, enabled, resolution_status, pending_resolution)
         VALUES (?, ?, 1, 'resolved', ?)`,
      )
      .run('already', JSON.stringify(['already']), JSON.stringify(payload));
    return Number(result.lastInsertRowid);
  }

  /** Create a web conversation via the public route and return its id. */
  async function createWebConversation(): Promise<number> {
    const res = await request(server.port, 'POST', '/conversations/new', {
      headers: authHeaders(),
      body: { channelId: 'web' },
    });
    expect(res.status).toBe(200);
    return (res.json() as { id: number }).id;
  }

  it('awaiting_clarify + entityId in candidates → 200 resolved + state flipped + assistant turn', async () => {
    const entityIds = seedEntities(3);
    const convId = await createWebConversation();
    const ruleId = seedAwaitingClarifyRule({
      candidateEntityIds: entityIds,
      conversationId: convId,
    });

    const res = await request(server.port, 'POST', `/tracking/rules/${ruleId}/resolve`, {
      headers: authHeaders(),
      body: { entityId: entityIds[0] },
    });
    expect(res.status).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.resolved).toBe(true);
    expect(body.ruleId).toBe(ruleId);
    expect(body.entityId).toBe(entityIds[0]);

    // Row state: resolution_status flipped, enabled re-armed, link inserted.
    const row = seedDb
      .prepare(`SELECT resolution_status, enabled FROM tracking_rules WHERE id = ?`)
      .get(ruleId) as { resolution_status: string; enabled: number };
    expect(row.resolution_status).toBe('resolved');
    expect(row.enabled).toBe(1);
    const linkRow = seedDb
      .prepare(
        `SELECT COUNT(*) as c FROM interest_entity_links WHERE interest_id = ? AND entity_id = ?`,
      )
      .get(ruleId, entityIds[0]) as { c: number };
    expect(linkRow.c).toBe(1);

    // Assistant turn appended with resultType=action. We assert metadata,
    // not text content — the i18n key `tracking.resolved_assistant_text` is
    // added in Task 10; until then `t()` returns the bare key string.
    const msgRow = seedDb
      .prepare(
        `SELECT role, metadata FROM conversation_messages
         WHERE conversation_id = ? AND role = 'assistant'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(convId) as { role: string; metadata: string | null };
    expect(msgRow?.role).toBe('assistant');
    const meta = msgRow.metadata ? JSON.parse(msgRow.metadata) : {};
    expect(meta.resultType).toBe('action');
    expect(meta.trackingRuleId).toBe(ruleId);
  });

  it('rule not in awaiting_clarify state → 409 invalid_status', async () => {
    const convId = await createWebConversation();
    const ruleId = seedResolvedRule({ conversationId: convId });

    const res = await request(server.port, 'POST', `/tracking/rules/${ruleId}/resolve`, {
      headers: authHeaders(),
      body: { entityId: 1 },
    });
    expect(res.status).toBe(409);
    expect((res.json() as Record<string, unknown>).code).toBe('invalid_status');
  });

  it('entityId not in pending_resolution.candidateEntityIds → 400 invalid_entity_id', async () => {
    const entityIds = seedEntities(2);
    const convId = await createWebConversation();
    const ruleId = seedAwaitingClarifyRule({
      candidateEntityIds: entityIds,
      conversationId: convId,
    });

    // 9999 is not in candidates and (with only 2 seeded) cannot exist.
    const res = await request(server.port, 'POST', `/tracking/rules/${ruleId}/resolve`, {
      headers: authHeaders(),
      body: { entityId: 9999 },
    });
    expect(res.status).toBe(400);
    expect((res.json() as Record<string, unknown>).code).toBe('invalid_entity_id');
  });

  it('rule missing → 404 rule_not_found', async () => {
    const res = await request(server.port, 'POST', '/tracking/rules/99999/resolve', {
      headers: authHeaders(),
      body: { entityId: 1 },
    });
    expect(res.status).toBe(404);
    expect((res.json() as Record<string, unknown>).code).toBe('rule_not_found');
  });
});
