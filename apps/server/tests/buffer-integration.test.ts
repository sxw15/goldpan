// apps/server/tests/buffer-integration.test.ts
//
// P3 Task 8 — Path D reconcile: GET /conversations/active & /:id
//
// Test architecture
// ─────────────────
// Same subprocess constraint as buffered.test.ts: in-process repo seeding
// (the plan's `conversationRepo.markBufferedWait(...)`) is not reachable
// from the test runner because the server runs as a child process and we
// can't co-open the SQLite DB without races. To create a buffered_wait
// message we'd need an LLM classifier stub harness driving `/input`, which
// does not yet exist (see input-classifier-v2.test.ts header).
//
// We follow the established convention: cover the HTTP contract
// unconditionally (route still mounted, response shape unchanged, no crash
// when there's nothing to reconcile) and gate end-to-end Path D coverage
// behind GOLDPAN_LLM_TEST_STUB so the file starts producing real coverage
// the moment the stub lands. Path D is **fire-and-forget** (P3 二轮 review
// 取舍 13) so the synchronous HTTP response is identical whether or not
// reconcile finds expired buffers — the smoke tests verify that the
// fire-and-forget addition didn't break the existing /active / /:id
// contracts (no extra latency, no error wrapping, no payload changes).

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

describe('Path D — GET /conversations/active reconcile (smoke)', () => {
  it('returns 200 + {id:null} with no buffers (fire-and-forget reconcile does not block / wrap response)', async () => {
    // The reconcile call is `void (async () => ...)()` — even if it threw
    // synchronously, the HTTP response must be unaffected. With an empty
    // DB findExpiredBuffered returns [] and the loop is a no-op, so this
    // case confirms the addition didn't change the happy-path contract.
    const res = await request(server.port, 'GET', '/conversations/active?channelId=web', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ id: null });
  });

  it('requires auth (reconcile must NOT run before the auth gate)', async () => {
    // Critical: scheduleReconcileForSession is gated behind authRequired();
    // an unauthenticated caller must not be able to trigger fan-out work.
    // Validated indirectly by getting a 401 (handler short-circuits before
    // the scheduleReconcileForSession call).
    const res = await request(server.port, 'GET', '/conversations/active?channelId=web');
    expect(res.status).toBe(401);
  });

  it('rejects non-web channelId without triggering reconcile', async () => {
    // 403 path is also pre-reconcile — confirms wiring is below the
    // cross-channel guard.
    const res = await request(server.port, 'GET', '/conversations/active?channelId=im', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(403);
  });
});

describe('Path D — GET /conversations/:id reconcile (smoke)', () => {
  it('returns 404 when conversation does not exist (reconcile not reached)', async () => {
    const res = await request(server.port, 'GET', '/conversations/99999999', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it('returns 200 + conversation payload for an existing conversation (reconcile fire-and-forget)', async () => {
    // Create a conversation, then load it — exercises the full path where
    // scheduleReconcileForConversation runs. With no buffered messages in
    // the DB the inner loop is a no-op, and the synchronous response is
    // the existing conversation read shape.
    const created = await request(server.port, 'POST', '/conversations/new', {
      headers: authHeaders(),
      body: { channelId: 'web' },
    });
    expect(created.status).toBe(200);
    const { id } = created.json() as { id: number };

    const res = await request(server.port, 'GET', `/conversations/${id}`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = res.json() as {
      id: number;
      sessionKey: string;
      channelId: string;
      messages: unknown[];
    };
    expect(body.id).toBe(id);
    expect(body.sessionKey).toBe('web:default');
    expect(body.channelId).toBe('web');
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it('requires auth (reconcile must NOT run before the auth gate)', async () => {
    const res = await request(server.port, 'GET', '/conversations/1');
    expect(res.status).toBe(401);
  });
});

// LLM-stub-gated end-to-end Path D coverage. Activates the moment a mock-LLM
// harness for the subprocess test server lands (see buffered.test.ts:99 /
// input-classifier-v2.test.ts:76 for the same pattern). Until then the
// describe block compiles + documents the contract but skips at runtime.
//
// These three cases are the plan-level scenarios:
//   1. GET /conversations/active finalizes an expired session buffer
//   2. GET /conversations/:id finalizes an expired per-conversation buffer
//   3. A non-expired buffer is left alone (grace window respected)
describe.skipIf(!process.env.GOLDPAN_LLM_TEST_STUB)(
  'Path D — end-to-end (requires LLM stub harness)',
  () => {
    it('GET /conversations/active triggers finalize for expired buffered (fire-and-forget; visible on next poll)', async () => {
      // Step 1: push a message into buffered_wait via /input + classifier stub.
      const waitRes = await request(server.port, 'POST', '/input', {
        headers: {
          ...authHeaders(),
          // wait:fallbackIntent:reason:durationMs — see input-classifier-v2.test.ts
          // header for stub contract; durationMs negative pushes the buffer
          // immediately past the Path D 5s grace.
          'x-test-classifier-decision': 'wait:create_note:incomplete_command:-60000',
        },
        body: { input: 'old message...', sessionKey: 'web:default' },
      });
      expect(waitRes.status).toBe(200);
      const waitBody = waitRes.json() as { type: string; bufferedMessageId: number };
      expect(waitBody.type).toBe('wait');
      const bufId = waitBody.bufferedMessageId;

      // Step 2: GET /conversations/active triggers Path D fire-and-forget.
      // The HTTP response itself is unchanged ({id:...}); the finalize runs
      // async after the response is sent.
      const activeRes = await request(server.port, 'GET', '/conversations/active?channelId=web', {
        headers: authHeaders(),
      });
      expect(activeRes.status).toBe(200);

      // Step 3: poll until the active conversation shows the assistant turn
      // produced by finalizeBuffer. We can't synchronously observe the
      // fire-and-forget completion, so a bounded poll on the read endpoint
      // verifies the eventual state.
      const { id: convId } = activeRes.json() as { id: number };
      expect(convId).toBeGreaterThan(0);

      let observed = false;
      for (let i = 0; i < 40; i++) {
        const conv = await request(server.port, 'GET', `/conversations/${convId}`, {
          headers: authHeaders(),
        });
        const body = conv.json() as { messages: Array<{ id: number; role: string }> };
        // The buffered user message should be consumed (no longer present
        // with id===bufId in the read-side response), and a new assistant
        // turn should follow.
        const bufStillThere = body.messages.find((m) => m.id === bufId);
        const hasAssistant = body.messages.some((m) => m.role === 'assistant');
        if (!bufStillThere && hasAssistant) {
          observed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(observed).toBe(true);
    });

    it('GET /conversations/:id triggers finalize for expired buffered in that conversation', async () => {
      const waitRes = await request(server.port, 'POST', '/input', {
        headers: {
          ...authHeaders(),
          'x-test-classifier-decision': 'wait:create_note:incomplete_command:-60000',
        },
        body: { input: 'another old one...', sessionKey: 'web:default' },
      });
      const { bufferedMessageId } = waitRes.json() as { bufferedMessageId: number };

      // Need the conversationId — fetch via /active before the finalize lands.
      const activeRes = await request(server.port, 'GET', '/conversations/active?channelId=web', {
        headers: authHeaders(),
      });
      const { id: convId } = activeRes.json() as { id: number };
      expect(convId).toBeGreaterThan(0);

      // Direct GET /:id — independent reconcile path. Same fire-and-forget;
      // poll for the finalize to materialize.
      let observed = false;
      for (let i = 0; i < 40; i++) {
        const conv = await request(server.port, 'GET', `/conversations/${convId}`, {
          headers: authHeaders(),
        });
        const body = conv.json() as { messages: Array<{ id: number; role: string }> };
        const bufStillThere = body.messages.find((m) => m.id === bufferedMessageId);
        const hasAssistant = body.messages.some((m) => m.role === 'assistant');
        if (!bufStillThere && hasAssistant) {
          observed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(observed).toBe(true);
    });

    it('non-expired buffered (within grace) is left alone by Path D', async () => {
      // 30s future expiry → well inside the 5s Path D grace; reconcile
      // must skip this row.
      const waitRes = await request(server.port, 'POST', '/input', {
        headers: {
          ...authHeaders(),
          'x-test-classifier-decision': 'wait:create_note:incomplete_command:30000',
        },
        body: { input: 'still buffering...', sessionKey: 'web:default' },
      });
      const { bufferedMessageId } = waitRes.json() as { bufferedMessageId: number };

      await request(server.port, 'GET', '/conversations/active?channelId=web', {
        headers: authHeaders(),
      });

      // Give the fire-and-forget a chance to (incorrectly) run.
      await new Promise((r) => setTimeout(r, 500));

      const activeRes = await request(server.port, 'GET', '/conversations/active?channelId=web', {
        headers: authHeaders(),
      });
      const { id: convId } = activeRes.json() as { id: number };
      const conv = await request(server.port, 'GET', `/conversations/${convId}`, {
        headers: authHeaders(),
      });
      const body = conv.json() as { messages: Array<{ id: number; role: string }> };
      // Buffered message still present (Path D respected the grace window).
      expect(body.messages.some((m) => m.id === bufferedMessageId)).toBe(true);
    });
  },
);
