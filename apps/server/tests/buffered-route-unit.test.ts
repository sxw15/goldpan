import type http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { handleBufferedCancel, handleBufferedRelease } from '../src/routes/buffered.js';
import type { RouteContext } from '../src/routes/types.js';

function makeCtx(message: {
  id: number;
  conversationId: number;
  sessionKey: string;
  conversationArchivedAt: number | null;
}) {
  const res = {
    writeHead: vi.fn(),
    end: vi.fn(),
  };
  const ctx = {
    req: {} as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    url: new URL('http://test/conversations/buffered/1/release'),
    segments: [],
    handle: {
      repos: {
        conversation: {
          getMessageById: vi.fn(() => message),
        },
      },
    },
    readBody: async () => null,
    getClientIp: () => '127.0.0.1',
    debugApiEnabled: false,
  } as unknown as RouteContext;
  return { ctx, res };
}

function jsonBody(res: { end: ReturnType<typeof vi.fn> }) {
  return JSON.parse(res.end.mock.calls[0][0] as string) as Record<string, unknown>;
}

describe('buffered route guards', () => {
  it('release rejects non-web buffered message ids before finalizing', async () => {
    const { ctx, res } = makeCtx({
      id: 1,
      conversationId: 1,
      sessionKey: 'tg:bot:c1',
      conversationArchivedAt: null,
    });

    await handleBufferedRelease(ctx, 1);

    expect(res.writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'application/json' });
    expect(jsonBody(res).code).toBe('forbidden_cross_channel');
  });

  it('cancel rejects non-web buffered message ids before consuming', async () => {
    const { ctx, res } = makeCtx({
      id: 1,
      conversationId: 1,
      sessionKey: 'tg:bot:c1',
      conversationArchivedAt: null,
    });

    await handleBufferedCancel(ctx, 1);

    expect(res.writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'application/json' });
    expect(jsonBody(res).code).toBe('forbidden_cross_channel');
  });
});
