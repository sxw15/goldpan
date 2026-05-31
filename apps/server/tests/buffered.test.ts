// apps/server/tests/buffered.test.ts
//
// P3 Task 6 — POST /conversations/buffered/:id/{release,cancel}
//
// Test architecture
// ─────────────────
// `startTestServer` spawns the server as a child process (helpers.ts),
// which means in-process repo seeding (the plan's
// `conversationRepo.markBufferedWait(...)`) is not reachable from the test
// runner. The only paths to create a buffered_wait message in the test DB
// are (a) drive `/input` with a classifier that returns `wait`, which
// needs an LLM stub harness that does not yet exist (see
// `input-classifier-v2.test.ts` header for the same constraint), or (b)
// reach into the spawned process's SQLite DB out-of-band.
//
// We follow the established convention: cover everything reachable over
// pure HTTP unconditionally (404 / auth / cancel-not-found / route shape)
// and gate the LLM-dependent CAS-success path behind GOLDPAN_LLM_TEST_STUB
// so the file documents the contract today and starts producing real
// coverage the moment the stub harness lands. The CAS-failure branch
// (release call against an already-consumed message) is exercised
// indirectly by the same gate — once the stub lets us push a message into
// buffered_wait, the test issues a back-to-back release/release and
// expects the second to report `already_finalized`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request, type StartedServer, startTestServer } from './helpers';

let server: StartedServer;

beforeAll(async () => {
  server = await startTestServer();
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

const authHeaders = () => ({ Authorization: `Bearer ${server.password}` });

describe('POST /conversations/buffered/:id/release — HTTP contract', () => {
  it('404 when messageId does not exist', async () => {
    const res = await request(server.port, 'POST', '/conversations/buffered/9999999/release', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
    const body = res.json() as { code: string };
    expect(body.code).toBe('not_found');
  });

  it('requires auth (route is mounted; 401 without bearer)', async () => {
    const res = await request(server.port, 'POST', '/conversations/buffered/1/release');
    // Global POST auth gate fires before the handler — important guarantee is
    // that the dispatch did NOT 404, so the route is mounted.
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });

  it('regex guard: non-numeric id falls through to global 404', async () => {
    const res = await request(server.port, 'POST', '/conversations/buffered/abc/release', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it('regex guard: unknown action falls through to global 404', async () => {
    const res = await request(server.port, 'POST', '/conversations/buffered/1/foo', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /conversations/buffered/:id/cancel — HTTP contract', () => {
  it('cancel against non-existent / non-buffered message → 200 + cancelled:false', async () => {
    // consumeBuffered CAS returns null when no row matches the (id, status)
    // predicate, so a random id behaves identically to a row that was
    // already consumed. Both surface as `cancelled:false / already_finalized`.
    const res = await request(server.port, 'POST', '/conversations/buffered/9999998/cancel', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = res.json() as { cancelled: boolean; reason: string };
    expect(body.cancelled).toBe(false);
    expect(body.reason).toBe('already_finalized');
  });

  it('requires auth (route is mounted; 401 without bearer)', async () => {
    const res = await request(server.port, 'POST', '/conversations/buffered/1/cancel');
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });
});

// LLM-stub-gated end-to-end coverage for the CAS-success + CAS-failure
// branches. Activates the moment a mock-LLM harness for the subprocess
// test server lands (see `input-classifier-v2.test.ts:76`). Until then the
// describe block compiles + documents the contract but skips at runtime.
describe.skipIf(!process.env.GOLDPAN_LLM_TEST_STUB)(
  'buffered release/cancel — end-to-end (requires LLM stub harness)',
  () => {
    it('release immediately finalizes a buffered_wait → 200 + executed:true', async () => {
      // Classifier stub: returns wait + fallbackIntent=create_note
      const waitRes = await request(server.port, 'POST', '/input', {
        headers: {
          ...authHeaders(),
          'x-test-classifier-decision': 'wait:create_note:incomplete_command:30000',
        },
        body: { input: '明天那个...', sessionKey: 'web:default' },
      });
      expect(waitRes.status).toBe(200);
      const waitBody = waitRes.json() as { type: string; bufferedMessageId: number };
      expect(waitBody.type).toBe('wait');
      expect(waitBody.bufferedMessageId).toBeGreaterThan(0);

      const releaseRes = await request(
        server.port,
        'POST',
        `/conversations/buffered/${waitBody.bufferedMessageId}/release`,
        { headers: authHeaders() },
      );
      expect(releaseRes.status).toBe(200);
      const releaseBody = releaseRes.json() as {
        executed: boolean;
        result: { type: string } | null;
        conversationId: number;
      };
      expect(releaseBody.executed).toBe(true);
      expect(releaseBody.result?.type).toBe('note');
      expect(releaseBody.conversationId).toBeGreaterThan(0);
    });

    it('release against already-consumed message → 200 + executed:false + already_finalized', async () => {
      // First release wins; second hits CAS-failure path.
      const waitRes = await request(server.port, 'POST', '/input', {
        headers: {
          ...authHeaders(),
          'x-test-classifier-decision': 'wait:create_note:incomplete_command:30000',
        },
        body: { input: '另一条等待...', sessionKey: 'web:default' },
      });
      const { bufferedMessageId } = waitRes.json() as { bufferedMessageId: number };

      const firstRelease = await request(
        server.port,
        'POST',
        `/conversations/buffered/${bufferedMessageId}/release`,
        { headers: authHeaders() },
      );
      expect((firstRelease.json() as { executed: boolean }).executed).toBe(true);

      const secondRelease = await request(
        server.port,
        'POST',
        `/conversations/buffered/${bufferedMessageId}/release`,
        { headers: authHeaders() },
      );
      expect(secondRelease.status).toBe(200);
      const body = secondRelease.json() as { executed: boolean; reason: string };
      expect(body.executed).toBe(false);
      expect(body.reason).toBe('already_finalized');
    });

    it('cancel on a buffered_wait → 200 + cancelled:true + no assistant turn written', async () => {
      const waitRes = await request(server.port, 'POST', '/input', {
        headers: {
          ...authHeaders(),
          'x-test-classifier-decision': 'wait:create_note:incomplete_command:30000',
        },
        body: { input: '取消那条...', sessionKey: 'web:default' },
      });
      const { bufferedMessageId } = waitRes.json() as { bufferedMessageId: number };

      const cancelRes = await request(
        server.port,
        'POST',
        `/conversations/buffered/${bufferedMessageId}/cancel`,
        { headers: authHeaders() },
      );
      expect(cancelRes.status).toBe(200);
      const body = cancelRes.json() as { cancelled: boolean; conversationId: number };
      expect(body.cancelled).toBe(true);
      expect(body.conversationId).toBeGreaterThan(0);

      // Cancel must NOT have written an assistant turn — verify via the
      // conversation read endpoint (server filters internal metadata).
      const convRes = await request(server.port, 'GET', `/conversations/${body.conversationId}`, {
        headers: authHeaders(),
      });
      const conv = convRes.json() as { messages: Array<{ role: string }> };
      const assistantTurns = conv.messages.filter((m) => m.role === 'assistant');
      expect(assistantTurns.length).toBe(0);
    });
  },
);
