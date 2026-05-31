// apps/server/tests/routes/notes.test.ts —— 覆盖 /user-notes/* HTTP 路由（server contract 路径在 P6 范围外保留不变；sdk method 名已在 P6 改成 createNote / listNotes 等）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request, type StartedServer, startTestServer } from '../helpers';

let server: StartedServer;
let ipCounter = 0;

beforeAll(async () => {
  server = await startTestServer({ envOverrides: { GOLDPAN_TRUST_PROXY: 'true' } });
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

const authHeaders = () => {
  const i = ++ipCounter;
  return {
    Authorization: `Bearer ${server.password}`,
    'X-Forwarded-For': `127.0.${(i >> 8) & 0xff}.${i & 0xff}`,
  };
};

const promotableNoteContent = (label = 'promotable note') =>
  `${label} ${'with enough context '.repeat(40)}`.trim();

describe('POST /user-notes', () => {
  it('401 without auth', async () => {
    const res = await request(server.port, 'POST', '/user-notes', {
      body: { content: 'x' },
    });
    expect(res.status).toBe(401);
  });

  it('creates a note (201) with minimal input', async () => {
    const res = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'hello note', subtype: 'memo' },
    });
    expect(res.status).toBe(201);
    const json = res.json() as Record<string, unknown>;
    expect(typeof json.id).toBe('number');
    expect(json.content).toBe('hello note');
    expect(json.subtype).toBe('memo');
    expect(json.archived).toBe(false);
    expect(json.tags).toEqual([]);
  });

  it('400 when content empty', async () => {
    const res = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: '' },
    });
    expect(res.status).toBe(400);
    expect((res.json() as Record<string, unknown>).code).toBe('invalid_content');
  });

  it('400 when content too long', async () => {
    // Default GOLDPAN_MAX_TEXT_INPUT_LENGTH=20000; pick a value just over so
    // we exceed the route's content_too_long branch without tripping global
    // body-size limits earlier in the pipeline.
    const longContent = 'x'.repeat(25_000);
    const res = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: longContent },
    });
    expect(res.status).toBe(400);
    expect((res.json() as Record<string, unknown>).code).toBe('content_too_long');
  });

  it('400 when subtype not in whitelist', async () => {
    const res = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'x', subtype: 'evil' },
    });
    expect(res.status).toBe(400);
    expect((res.json() as Record<string, unknown>).code).toBe('invalid_subtype');
  });
});

describe('GET /user-notes', () => {
  it('lists created notes', async () => {
    for (let i = 0; i < 3; i++) {
      await request(server.port, 'POST', '/user-notes', {
        headers: authHeaders(),
        body: { content: `list-note-${i}` },
      });
    }
    const res = await request(server.port, 'GET', '/user-notes?limit=50', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const json = res.json() as { data: unknown[]; nextCursor: string | null };
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.length).toBeGreaterThanOrEqual(3);
  });

  it('supports subtype filter', async () => {
    await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'memo-1', subtype: 'memo' },
    });
    await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'note-1', subtype: 'note' },
    });

    const res = await request(server.port, 'GET', '/user-notes?subtype=memo&limit=50', {
      headers: authHeaders(),
    });
    const json = res.json() as { data: Array<{ subtype: string }> };
    expect(json.data.every((n) => n.subtype === 'memo')).toBe(true);
  });

  it('maps legacy collapsed subtype query values to note', async () => {
    await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'legacy-query-memo', subtype: 'memo' },
    });
    await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'legacy-query-note', subtype: 'note' },
    });

    const res = await request(
      server.port,
      'GET',
      '/user-notes?subtype=idea,reflection,observation&search=legacy-query&limit=50',
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);
    const json = res.json() as { data: Array<{ content: string; subtype: string }> };
    expect(json.data.map((n) => n.content)).toContain('legacy-query-note');
    expect(json.data.map((n) => n.content)).not.toContain('legacy-query-memo');
    expect(json.data.every((n) => n.subtype === 'note')).toBe(true);
  });

  it('supports search', async () => {
    await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'hello world UniqueSearchKeyword' },
    });
    const res = await request(server.port, 'GET', '/user-notes?search=UniqueSearchKeyword', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const json = res.json() as { data: unknown[] };
    expect(json.data.length).toBeGreaterThanOrEqual(1);
  });

  it('400 for malformed numeric filters', async () => {
    for (const query of [
      'limit=abc',
      'cursor=abc',
      'cursor=1e2:1',
      'cursor=%20100:1',
      'entityId=abc',
      'sourceId=abc',
    ]) {
      const res = await request(server.port, 'GET', `/user-notes?${query}`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);
      expect((res.json() as Record<string, unknown>).code).toBe('invalid_query');
    }
  });
});

describe('GET /user-notes/:id', () => {
  it('returns note detail', async () => {
    const create = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'detail-test' },
    });
    const created = create.json() as { id: number };

    const res = await request(server.port, 'GET', `/user-notes/${created.id}`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect((res.json() as { id: number }).id).toBe(created.id);
  });

  it('404 for non-existent id', async () => {
    const res = await request(server.port, 'GET', '/user-notes/99999', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
    expect((res.json() as Record<string, unknown>).code).toBe('note_not_found');
  });

  it('400 for non-numeric id', async () => {
    const res = await request(server.port, 'GET', '/user-notes/abc', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    expect((res.json() as Record<string, unknown>).code).toBe('invalid_id');
  });
});

describe('PATCH /user-notes/:id', () => {
  it('updates note fields', async () => {
    const create = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'patch-test' },
    });
    const created = create.json() as { id: number };

    const res = await request(server.port, 'PATCH', `/user-notes/${created.id}`, {
      headers: authHeaders(),
      body: { content: 'updated', pinned: true },
    });
    expect(res.status).toBe(200);
    const json = res.json() as Record<string, unknown>;
    expect(json.content).toBe('updated');
    expect(json.pinned).toBe(true);
  });

  it('clears tags with empty array', async () => {
    const create = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'clear-tags-test', tags: ['keep'] },
    });
    const created = create.json() as { id: number; tags: string[] };
    expect(created.tags).toEqual(['keep']);

    const res = await request(server.port, 'PATCH', `/user-notes/${created.id}`, {
      headers: authHeaders(),
      body: { tags: [] },
    });
    expect(res.status).toBe(200);
    expect((res.json() as { tags: string[] }).tags).toEqual([]);
  });

  it('404 for non-existent id', async () => {
    const res = await request(server.port, 'PATCH', '/user-notes/99999', {
      headers: authHeaders(),
      body: { content: 'x' },
    });
    expect(res.status).toBe(404);
  });

  it('400 when subtype not in whitelist', async () => {
    const create = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'subtype-validation-test' },
    });
    const created = create.json() as { id: number };

    const res = await request(server.port, 'PATCH', `/user-notes/${created.id}`, {
      headers: authHeaders(),
      body: { subtype: 'evil' },
    });
    expect(res.status).toBe(400);
    expect((res.json() as Record<string, unknown>).code).toBe('invalid_subtype');
  });

  it('accepts known fields and silently ignores unknown ones in PATCH body', async () => {
    // Validates PATCH does not 400 / 500 on unknown fields. The response NoteDetail
    // shape doesn't include `foo`/`bar`, so we cannot directly assert DB stayed
    // clean — but route-side destructuring ensures unknowns never reach repo.
    const create = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'unknown-field-test' },
    });
    const created = create.json() as { id: number };

    const res = await request(server.port, 'PATCH', `/user-notes/${created.id}`, {
      headers: authHeaders(),
      body: { pinned: true, foo: 'should-be-ignored', bar: 12345 },
    });
    expect(res.status).toBe(200);
    expect((res.json() as Record<string, unknown>).pinned).toBe(true);
  });
});

describe('DELETE /user-notes/:id', () => {
  it('deletes a note (204) + subsequent GET 404', async () => {
    const create = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'delete-test' },
    });
    const created = create.json() as { id: number };

    const del = await request(server.port, 'DELETE', `/user-notes/${created.id}`, {
      headers: authHeaders(),
    });
    expect(del.status).toBe(204);

    const get = await request(server.port, 'GET', `/user-notes/${created.id}`, {
      headers: authHeaders(),
    });
    expect(get.status).toBe(404);
  });

  it('404 for non-existent id', async () => {
    const res = await request(server.port, 'DELETE', '/user-notes/99999', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /user-notes/:id/promote', () => {
  it('returns 404 when note not found', async () => {
    const res = await request(server.port, 'POST', '/user-notes/99999/promote', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
    expect((res.json() as Record<string, unknown>).code).toBe('note_not_found');
  });

  it('returns 400 when note is archived', async () => {
    const create = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'sample for archive promote test' },
    });
    expect(create.status).toBe(201);
    const noteId = (create.json() as Record<string, unknown>).id as number;
    await request(server.port, 'PATCH', `/user-notes/${noteId}`, {
      headers: authHeaders(),
      body: { archived: true },
    });

    const res = await request(server.port, 'POST', `/user-notes/${noteId}/promote`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    expect((res.json() as Record<string, unknown>).code).toBe('note_archived');
  });

  it('returns 200 + creates source + note_sources link on happy path', async () => {
    const create = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: {
        content: promotableNoteContent('happy path promote note'),
      },
    });
    expect(create.status).toBe(201);
    const noteId = (create.json() as Record<string, unknown>).id as number;

    const res = await request(server.port, 'POST', `/user-notes/${noteId}/promote`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.taskId).toEqual(expect.any(Number));
    expect(body.sourceId).toEqual(expect.any(Number));

    // GET the note → verify linkedSources now includes derived_from relation
    const note = await request(server.port, 'GET', `/user-notes/${noteId}`, {
      headers: authHeaders(),
    });
    const noteBody = note.json() as { linkedSources: Array<{ relation: string }> };
    expect(noteBody.linkedSources).toContainEqual(
      expect.objectContaining({ relation: 'derived_from' }),
    );
  });

  it('returns the same task/source on repeated promote', async () => {
    const create = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: {
        content: promotableNoteContent('idempotent promote note'),
      },
    });
    expect(create.status).toBe(201);
    const noteId = (create.json() as Record<string, unknown>).id as number;

    const first = await request(server.port, 'POST', `/user-notes/${noteId}/promote`, {
      headers: authHeaders(),
    });
    const second = await request(server.port, 'POST', `/user-notes/${noteId}/promote`, {
      headers: authHeaders(),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it('returns 400 when note is shorter than the promotion minimum', async () => {
    const create = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'short note' },
    });
    expect(create.status).toBe(201);
    const noteId = (create.json() as Record<string, unknown>).id as number;

    const res = await request(server.port, 'POST', `/user-notes/${noteId}/promote`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(400);
    expect((res.json() as Record<string, unknown>).code).toBe('note_too_short');
  });

  it('returns 400 on invalid id', async () => {
    const res = await request(server.port, 'POST', '/user-notes/abc/promote', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /user-notes/:id/translate', () => {
  // Happy path (200 + LLM translation) belongs to core unit tests
  // (translateNote with stubbed callLlm). Subprocess server can't inject a
  // mock LLM, so the integration suite only verifies routing + pre-LLM
  // error paths (404 / 400).

  it('returns 404 when note does not exist', async () => {
    const res = await request(server.port, 'POST', '/user-notes/9999/translate', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
    expect((res.json() as { code: string }).code).toBe('note_not_found');
  });

  it('returns 400 already_target_language when note.language matches server language', async () => {
    // Server is started with default GOLDPAN_LANGUAGE='en'; create a note
    // tagged 'en' so translateNote rejects before reaching the LLM.
    const created = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'hello plan', subtype: 'memo', language: 'en' },
    });
    expect(created.status).toBe(201);
    const noteId = (created.json() as { id: number }).id;

    const res = await request(server.port, 'POST', `/user-notes/${noteId}/translate`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    expect((res.json() as { code: string }).code).toBe('already_target_language');
  });

  it('returns 400 note_archived when note is archived', async () => {
    const created = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: '需要翻译的归档笔记', subtype: 'memo', language: 'zh' },
    });
    expect(created.status).toBe(201);
    const noteId = (created.json() as { id: number }).id;
    const archived = await request(server.port, 'PATCH', `/user-notes/${noteId}`, {
      headers: authHeaders(),
      body: { archived: true },
    });
    expect(archived.status).toBe(200);

    const res = await request(server.port, 'POST', `/user-notes/${noteId}/translate`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    expect((res.json() as { code: string }).code).toBe('note_archived');
  });

  it('returns 400 invalid_id when id segment is not a positive integer', async () => {
    const res = await request(server.port, 'POST', '/user-notes/abc/translate', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    expect((res.json() as { code: string }).code).toBe('invalid_id');
  });
});

describe('PATCH /user-notes/:id with dueAt (P7.4)', () => {
  it('sets dueAt and reflects in GET detail', async () => {
    const created = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'memo content', subtype: 'memo' },
    });
    expect(created.status).toBe(201);
    const noteId = (created.json() as { id: number }).id;

    const due = Date.now() + 60_000;
    const patched = await request(server.port, 'PATCH', `/user-notes/${noteId}`, {
      headers: authHeaders(),
      body: { dueAt: due },
    });
    expect(patched.status).toBe(200);
    expect((patched.json() as { dueAt: number }).dueAt).toBe(due);
  });

  it('PATCH dueAt=null clears the reminder', async () => {
    const created = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'clearable', subtype: 'memo' },
    });
    const noteId = (created.json() as { id: number }).id;

    await request(server.port, 'PATCH', `/user-notes/${noteId}`, {
      headers: authHeaders(),
      body: { dueAt: Date.now() + 10_000 },
    });
    const cleared = await request(server.port, 'PATCH', `/user-notes/${noteId}`, {
      headers: authHeaders(),
      body: { dueAt: null },
    });
    expect(cleared.status).toBe(200);
    expect((cleared.json() as { dueAt: number | null }).dueAt).toBeNull();
  });

  it('400 for dueAt outside the JavaScript Date range', async () => {
    const created = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'bad due', subtype: 'memo' },
    });
    const noteId = (created.json() as { id: number }).id;

    const res = await request(server.port, 'PATCH', `/user-notes/${noteId}`, {
      headers: authHeaders(),
      body: { dueAt: 9_000_000_000_000_000 },
    });
    expect(res.status).toBe(400);
    expect((res.json() as Record<string, unknown>).code).toBe('invalid_dueAt');
  });
});

describe('GET /user-notes with dueBefore + hasReminder (P7.4)', () => {
  it('400 for malformed dueBefore', async () => {
    for (const query of ['dueBefore=', 'dueBefore=1.5', 'dueBefore=1e3', 'dueBefore=-1']) {
      const res = await request(server.port, 'GET', `/user-notes?${query}`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);
      expect((res.json() as Record<string, unknown>).code).toBe('invalid_dueBefore');
    }
  });

  it('returns only pending-reminder memos before cutoff', async () => {
    const past = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'past', subtype: 'memo' },
    });
    const pastId = (past.json() as { id: number }).id;
    await request(server.port, 'PATCH', `/user-notes/${pastId}`, {
      headers: authHeaders(),
      body: { dueAt: Date.now() - 60_000 },
    });

    const future = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'future', subtype: 'memo' },
    });
    const futureId = (future.json() as { id: number }).id;
    await request(server.port, 'PATCH', `/user-notes/${futureId}`, {
      headers: authHeaders(),
      body: { dueAt: Date.now() + 600_000 },
    });

    const out = await request(
      server.port,
      'GET',
      `/user-notes?subtype=memo&dueBefore=${Date.now()}&hasReminder=true`,
      { headers: authHeaders() },
    );
    expect(out.status).toBe(200);
    const ids = (out.json() as { data: Array<{ id: number }> }).data.map((n) => n.id);
    expect(ids).toContain(pastId);
    expect(ids).not.toContain(futureId);
  });
});

describe('POST /user-notes/:id/mark-reminded (P7.4)', () => {
  it('sets remindedAt and 200 returns the timestamp', async () => {
    const created = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'remindable', subtype: 'memo' },
    });
    const noteId = (created.json() as { id: number }).id;
    await request(server.port, 'PATCH', `/user-notes/${noteId}`, {
      headers: authHeaders(),
      body: { dueAt: Date.now() - 1_000 },
    });

    const res = await request(server.port, 'POST', `/user-notes/${noteId}/mark-reminded`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = res.json() as { remindedAt: number };
    expect(typeof body.remindedAt).toBe('number');
    expect(body.remindedAt).toBeGreaterThan(0);
  });

  it('honors expectedDueAt on the happy path', async () => {
    const created = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'expected due', subtype: 'memo' },
    });
    const noteId = (created.json() as { id: number }).id;
    const dueAt = Date.now() - 2_000;
    await request(server.port, 'PATCH', `/user-notes/${noteId}`, {
      headers: authHeaders(),
      body: { dueAt },
    });

    const res = await request(server.port, 'POST', `/user-notes/${noteId}/mark-reminded`, {
      headers: authHeaders(),
      body: { expectedDueAt: dueAt },
    });
    expect(res.status).toBe(200);
  });

  it('400 when note has no due reminder', async () => {
    const created = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'no due', subtype: 'memo' },
    });
    const noteId = (created.json() as { id: number }).id;

    const res = await request(server.port, 'POST', `/user-notes/${noteId}/mark-reminded`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    expect((res.json() as Record<string, unknown>).code).toBe('note_reminder_not_pending');
  });

  it('409 when expectedDueAt no longer matches current reminder', async () => {
    const created = await request(server.port, 'POST', '/user-notes', {
      headers: authHeaders(),
      body: { content: 'stale due', subtype: 'memo' },
    });
    const noteId = (created.json() as { id: number }).id;
    const oldDue = Date.now() - 5_000;
    const newDue = Date.now() + 60_000;
    await request(server.port, 'PATCH', `/user-notes/${noteId}`, {
      headers: authHeaders(),
      body: { dueAt: oldDue },
    });
    await request(server.port, 'PATCH', `/user-notes/${noteId}`, {
      headers: authHeaders(),
      body: { dueAt: newDue },
    });

    const res = await request(server.port, 'POST', `/user-notes/${noteId}/mark-reminded`, {
      headers: authHeaders(),
      body: { expectedDueAt: oldDue },
    });
    expect(res.status).toBe(409);
    expect((res.json() as Record<string, unknown>).code).toBe('note_reminder_not_pending');
  });

  it('returns 404 when note does not exist', async () => {
    const res = await request(server.port, 'POST', '/user-notes/999999/mark-reminded', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });
});
