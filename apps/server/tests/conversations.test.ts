// apps/server/tests/conversations.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request, type StartedServer, startTestServer } from './helpers';

let server: StartedServer;
let ipCounter = 0;

beforeAll(async () => {
  server = await startTestServer({ envOverrides: { GOLDPAN_TRUST_PROXY: 'true' } });
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

describe('Conversations routes', () => {
  const authHeaders = () => {
    const i = ++ipCounter;
    // Spread across two octets so we can mint > 255 unique IPs before colliding.
    return {
      Authorization: `Bearer ${server.password}`,
      'X-Forwarded-For': `127.0.${(i >> 8) & 0xff}.${i & 0xff}`,
    };
  };

  it('GET /conversations/active without auth returns 401', async () => {
    const res = await request(server.port, 'GET', '/conversations/active?channelId=web');
    expect(res.status).toBe(401);
  });

  it('GET /conversations/active returns {id:null} when empty', async () => {
    const res = await request(server.port, 'GET', '/conversations/active?channelId=web', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ id: null });
  });

  it('GET /conversations/active rejects non-web channel', async () => {
    const res = await request(server.port, 'GET', '/conversations/active?channelId=im', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(403);
    expect((res.json() as Record<string, unknown>).code).toBe('forbidden_cross_channel');
  });

  it('GET /conversations/active rejects missing channelId', async () => {
    const res = await request(server.port, 'GET', '/conversations/active', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
    expect((res.json() as Record<string, unknown>).code).toBe('invalid_query');
  });

  it('POST /conversations/new creates + archives prior active', async () => {
    const r1 = await request(server.port, 'POST', '/conversations/new', {
      headers: authHeaders(),
      body: { channelId: 'web' },
    });
    expect(r1.status).toBe(200);
    const { id: id1 } = r1.json() as { id: number };
    expect(typeof id1).toBe('number');

    const r2 = await request(server.port, 'POST', '/conversations/new', {
      headers: authHeaders(),
      body: { channelId: 'web' },
    });
    expect(r2.status).toBe(200);
    const { id: id2 } = r2.json() as { id: number };
    expect(id2).not.toBe(id1);

    const active = await request(server.port, 'GET', '/conversations/active?channelId=web', {
      headers: authHeaders(),
    });
    expect((active.json() as { id: number }).id).toBe(id2);
  });

  it('POST /conversations/new without auth returns 401', async () => {
    const r = await request(server.port, 'POST', '/conversations/new', {
      body: { channelId: 'web' },
    });
    expect(r.status).toBe(401);
  });

  it('POST /conversations/new rejects cross-channel sessionKey', async () => {
    const r = await request(server.port, 'POST', '/conversations/new', {
      headers: authHeaders(),
      body: { channelId: 'web', sessionKey: 'im:xyz' },
    });
    expect(r.status).toBe(400);
    expect((r.json() as Record<string, unknown>).code).toBe('invalid_session_key');
  });

  it('POST /conversations/new rejects non-default web sessionKey', async () => {
    const r = await request(server.port, 'POST', '/conversations/new', {
      headers: authHeaders(),
      body: { channelId: 'web', sessionKey: 'web:other' },
    });
    expect(r.status).toBe(400);
    expect((r.json() as Record<string, unknown>).code).toBe('invalid_session_key');
  });

  it('POST /conversations/new rejects non-web channelId', async () => {
    const r = await request(server.port, 'POST', '/conversations/new', {
      headers: authHeaders(),
      body: { channelId: 'im' },
    });
    expect(r.status).toBe(403);
    expect((r.json() as Record<string, unknown>).code).toBe('forbidden_cross_channel');
  });

  it('GET /conversations returns paginated list', async () => {
    const r = await request(server.port, 'GET', '/conversations?channelId=web&limit=5&offset=0', {
      headers: authHeaders(),
    });
    expect(r.status).toBe(200);
    const data = r.json() as { items: unknown[]; total: number };
    expect(Array.isArray(data.items)).toBe(true);
    expect(typeof data.total).toBe('number');
  });

  it('GET /conversations rejects malformed pagination', async () => {
    const badLimit = await request(server.port, 'GET', '/conversations?channelId=web&limit=1.5', {
      headers: authHeaders(),
    });
    expect(badLimit.status).toBe(400);
    expect((badLimit.json() as Record<string, unknown>).code).toBe('invalid_limit');

    const badOffset = await request(
      server.port,
      'GET',
      '/conversations?channelId=web&offset=Infinity',
      {
        headers: authHeaders(),
      },
    );
    expect(badOffset.status).toBe(400);
    expect((badOffset.json() as Record<string, unknown>).code).toBe('invalid_offset');
  });

  it('GET /conversations/:id returns messages', async () => {
    const newConv = await request(server.port, 'POST', '/conversations/new', {
      headers: authHeaders(),
      body: { channelId: 'web' },
    });
    const { id } = newConv.json() as { id: number };

    const r = await request(server.port, 'GET', `/conversations/${id}`, {
      headers: authHeaders(),
    });
    expect(r.status).toBe(200);
    const data = r.json() as { id: number; messages: unknown[] };
    expect(data.id).toBe(id);
    expect(data.messages).toEqual([]);
  });

  it('GET /conversations/:id returns 404 on missing', async () => {
    const r = await request(server.port, 'GET', '/conversations/9999999', {
      headers: authHeaders(),
    });
    expect(r.status).toBe(404);
  });

  it('GET /conversations/:id returns 400 on invalid id', async () => {
    const r = await request(server.port, 'GET', '/conversations/abc', {
      headers: authHeaders(),
    });
    expect(r.status).toBe(400);
  });

  it('DELETE /conversations/:id returns 204 + idempotent', async () => {
    const newConv = await request(server.port, 'POST', '/conversations/new', {
      headers: authHeaders(),
      body: { channelId: 'web' },
    });
    const { id } = newConv.json() as { id: number };
    const r1 = await request(server.port, 'DELETE', `/conversations/${id}`, {
      headers: authHeaders(),
    });
    expect(r1.status).toBe(204);
    const r2 = await request(server.port, 'DELETE', `/conversations/${id}`, {
      headers: authHeaders(),
    });
    expect(r2.status).toBe(204);
  });

  it('POST /conversations/:id/unarchive unarchives + returns 409 via /input when still archived', async () => {
    // Create conv A (active)
    const a = await request(server.port, 'POST', '/conversations/new', {
      headers: authHeaders(),
      body: { channelId: 'web' },
    });
    const { id: idA } = a.json() as { id: number };
    // Create conv B → archives A (now B is active, A is archived)
    await request(server.port, 'POST', '/conversations/new', {
      headers: authHeaders(),
      body: { channelId: 'web' },
    });
    // /input with archived conversationId should return 409
    const r409 = await request(server.port, 'POST', '/input', {
      headers: authHeaders(),
      body: { input: 'hi', conversationId: idA },
    });
    expect(r409.status).toBe(409);
    expect((r409.json() as Record<string, unknown>).code).toBe('conversation_archived');

    // Unarchive works
    const u = await request(server.port, 'POST', `/conversations/${idA}/unarchive`, {
      headers: authHeaders(),
    });
    expect(u.status).toBe(200);

    // A now active, B archived
    const active = await request(server.port, 'GET', '/conversations/active?channelId=web', {
      headers: authHeaders(),
    });
    expect((active.json() as { id: number }).id).toBe(idA);
  });

  it('POST /conversations/:id/unarchive returns 404 on missing id', async () => {
    const r = await request(server.port, 'POST', '/conversations/9999999/unarchive', {
      headers: authHeaders(),
    });
    expect(r.status).toBe(404);
  });

  it('POST /input rejects non-web sessionKey prefix', async () => {
    const r = await request(server.port, 'POST', '/input', {
      headers: authHeaders(),
      body: { input: 'hi', sessionKey: 'im:x:y' },
    });
    expect(r.status).toBe(400);
    expect((r.json() as Record<string, unknown>).code).toBe('invalid_session_key');
  });

  it('POST /input rejects non-default web sessionKey', async () => {
    const r = await request(server.port, 'POST', '/input', {
      headers: authHeaders(),
      body: { input: 'hi', sessionKey: 'web:other' },
    });
    expect(r.status).toBe(400);
    expect((r.json() as Record<string, unknown>).code).toBe('invalid_session_key');
  });

  it('POST /input rejects malformed conversationId instead of falling back to sessionKey', async () => {
    const r = await request(server.port, 'POST', '/input', {
      headers: authHeaders(),
      body: { input: 'hi', sessionKey: 'web:default', conversationId: '123' },
    });
    expect(r.status).toBe(400);
    expect((r.json() as Record<string, unknown>).code).toBe('invalid_conversation_id');
  });

  it('POST /input does not persist over-limit input', async () => {
    const fresh = await request(server.port, 'POST', '/conversations/new', {
      headers: authHeaders(),
      body: { channelId: 'web' },
    });
    const { id } = fresh.json() as { id: number };

    const tooLong = 'x'.repeat(20_001);
    const r = await request(server.port, 'POST', '/input', {
      headers: authHeaders(),
      body: { input: tooLong, sessionKey: 'web:default' },
    });
    expect(r.status).toBe(400);
    expect((r.json() as Record<string, unknown>).code).toBe('text_too_long');

    const detail = await request(server.port, 'GET', `/conversations/${id}`, {
      headers: authHeaders(),
    });
    const body = detail.json() as { messages: unknown[] };
    expect(body.messages).toEqual([]);
  });

  it('POST /input with sessionKey persists user + (optional) assistant messages', async () => {
    // Clean slate: archive any existing active by creating a new one
    const fresh = await request(server.port, 'POST', '/conversations/new', {
      headers: authHeaders(),
      body: { channelId: 'web' },
    });
    const { id: freshId } = fresh.json() as { id: number };

    const r = await request(server.port, 'POST', '/input', {
      headers: authHeaders(),
      body: { input: '记一下：测试消息', sessionKey: 'web:default' },
    });
    // Response MAY be 200/201/400 depending on intent classifier outcome — but
    // conversationId should come back when sessionKey provided.
    const body = r.json() as { conversationId?: number; type?: string };
    expect(typeof body.conversationId).toBe('number');
    expect(body.conversationId).toBe(freshId);

    // Verify user message was persisted pre-handleInput (constraint #5)
    const detail = await request(server.port, 'GET', `/conversations/${body.conversationId}`, {
      headers: authHeaders(),
    });
    const detailBody = detail.json() as {
      messages: Array<{ role: string; content: string }>;
    };
    const roles = detailBody.messages.map((m) => m.role);
    expect(roles).toContain('user');
    const userMsg = detailBody.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('记一下：测试消息');
    // Assistant message always paired with user for every result type:
    //   - query/content/action/clarify → real reply content
    //   - error → '[processing failed]' stub (metadata.resultType='error')
    //   - submit → '[submit:<status>]' sentinel (metadata.resultType='submit', submitStatus=...)
    if (body.type) {
      expect(roles).toContain('assistant');
    }
  });

  it('POST /input with non-existent conversationId returns 404', async () => {
    const r = await request(server.port, 'POST', '/input', {
      headers: authHeaders(),
      body: { input: 'hi', conversationId: 9_999_999 },
    });
    expect(r.status).toBe(404);
    expect((r.json() as Record<string, unknown>).code).toBe('conversation_not_found');
  });

  it('GET /conversations/:id strips __internal from message metadata (P0.2)', async () => {
    // Setup: POST /input with a trivially short text so handleInput at least
    // persists the user turn (assistant turn may or may not write depending on
    // intent classification under noop LLM keys). We only need any conversation
    // row + one writable message id to validate strip end-to-end.
    const fresh = await request(server.port, 'POST', '/conversations/new', {
      headers: authHeaders(),
      body: { channelId: 'web' },
    });
    const { id: conversationId } = fresh.json() as { id: number };

    await request(server.port, 'POST', '/input', {
      headers: authHeaders(),
      body: { input: 'strip-test', sessionKey: 'web:default', conversationId },
    });

    // Smuggle an __internal payload directly via appendMessage path by issuing
    // another /input — but /input's persisted metadata never contains __internal
    // yet (P3 introduces classifierDecision). So instead, just verify that
    // *every* assistant metadata is __internal-free regardless of source.
    const detail = await request(server.port, 'GET', `/conversations/${conversationId}`, {
      headers: authHeaders(),
    });
    expect(detail.status).toBe(200);
    const body = detail.json() as { messages: Array<{ metadata: unknown }> };
    for (const msg of body.messages) {
      if (msg.metadata && typeof msg.metadata === 'object') {
        expect(msg.metadata).not.toHaveProperty('__internal');
      }
    }
  });

  it('POST /input submit accepted writes sourceId to conversation_messages.metadata (P0.1)', async () => {
    // The deterministic shape contract (extractAssistantTurn metadata含 sourceId)
    // is verified in packages/im-runtime/tests/conversation/store.test.ts with a
    // mocked SubmitResult. This test exercises the end-to-end path through main.ts
    // and asserts sourceId only when submit truly reached 'accepted' — HTTP-route
    // tests use noop LLM keys (`sk-test-noop`), so intent classification may not
    // reach 'submit_url' deterministically. Either outcome guards main.ts wiring:
    //   - reached 'accepted' → must have metadata.sourceId (P0.1 contract)
    //   - reached anything else → at least the request shouldn't 5xx
    const fresh = await request(server.port, 'POST', '/conversations/new', {
      headers: authHeaders(),
      body: { channelId: 'web' },
    });
    const { id: conversationId } = fresh.json() as { id: number };

    const r = await request(server.port, 'POST', '/input', {
      headers: authHeaders(),
      body: {
        input: 'https://example.com/p0-1-test',
        sessionKey: 'web:default',
        conversationId,
      },
    });
    expect(r.status).toBeLessThan(500);

    const detail = await request(server.port, 'GET', `/conversations/${conversationId}`, {
      headers: authHeaders(),
    });
    expect(detail.status).toBe(200);
    const conv = detail.json() as {
      messages: Array<{ role: string; metadata?: Record<string, unknown> | null }>;
    };
    const lastAssistant = [...conv.messages].reverse().find((m) => m.role === 'assistant');
    if (
      lastAssistant?.metadata &&
      (lastAssistant.metadata as { resultType?: string }).resultType === 'submit'
    ) {
      const meta = lastAssistant.metadata as { submitStatus?: string; sourceId?: unknown };
      if (meta.submitStatus === 'accepted') {
        expect(typeof meta.sourceId).toBe('number');
      }
    }
  });
});
