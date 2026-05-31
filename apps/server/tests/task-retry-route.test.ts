import type http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { handleTaskRoutes } from '../src/routes/tasks.js';
import type { RouteContext } from '../src/routes/types.js';

// In-process unit test for the POST /tasks/:id/retry precondition gate. The
// HTTP integration harness (routes.test.ts) spawns the server as a child
// process and can't deterministically seed a non-retryable task, so we exercise
// the route handler directly with mocked repos. This guards the
// `not_retryable → 409` statusMap mapping that core's validateRetryPreconditions
// feeds (core's own predicate is unit-tested in task-ops.test.ts).
function makeRetryCtx(
  task: { id: number; sourceId: number; status: string; pipelineStep: string; errorKind: string },
  source: { id: number; kind: string; normalizedUrl: string | null },
) {
  const res = { writeHead: vi.fn(), end: vi.fn() };
  const ctx = {
    req: { method: 'POST', resume: vi.fn() } as unknown as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    url: new URL(`http://test/tasks/${task.id}/retry`),
    segments: [String(task.id), 'retry'],
    handle: {
      repos: {
        task: { getById: vi.fn(() => task) },
        source: {
          getById: vi.fn(() => source),
          findActiveByNormalizedUrl: vi.fn(() => null),
        },
      },
      db: {},
      logger: { error: vi.fn() },
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

describe('POST /tasks/:id/retry precondition gate', () => {
  it('returns 409 not_retryable for a content_policy failure', async () => {
    const { ctx, res } = makeRetryCtx(
      {
        id: 5,
        sourceId: 50,
        status: 'error',
        pipelineStep: 'verifying',
        errorKind: 'content_policy',
      },
      { id: 50, kind: 'user', normalizedUrl: null },
    );
    await handleTaskRoutes(ctx);
    expect(res.writeHead).toHaveBeenCalledWith(409, { 'Content-Type': 'application/json' });
    expect(jsonBody(res).code).toBe('not_retryable');
  });

  it('returns 409 not_retryable for a non-content_length content_validation failure', async () => {
    const { ctx, res } = makeRetryCtx(
      {
        id: 6,
        sourceId: 60,
        status: 'error',
        pipelineStep: 'content_validation',
        errorKind: 'unknown',
      },
      { id: 60, kind: 'user', normalizedUrl: null },
    );
    await handleTaskRoutes(ctx);
    expect(res.writeHead).toHaveBeenCalledWith(409, { 'Content-Type': 'application/json' });
    expect(jsonBody(res).code).toBe('not_retryable');
  });
});

// GET /tasks/:id error serialization — the data contract the web UI depends on
// (error.kind for localization, error.retryable for retry-gating). Both derive
// from the same isRetryableTaskError predicate as the POST gate above.
function makeGetCtx(task: {
  id: number;
  sourceId: number;
  status: string;
  pipelineStep: string;
  errorKind: string;
  createdAt: number;
}) {
  const res = { writeHead: vi.fn(), end: vi.fn() };
  const ctx = {
    req: { method: 'GET', resume: vi.fn() } as unknown as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    url: new URL(`http://test/tasks/${task.id}`),
    segments: [String(task.id)],
    handle: {
      repos: {
        task: { getById: vi.fn(() => task) },
        source: {
          getById: vi.fn(() => ({ id: task.sourceId, status: 'failed', originalUrl: null })),
        },
        taskLog: { getByTaskId: vi.fn(() => []) },
      },
      logger: { error: vi.fn() },
    },
    readBody: async () => null,
    getClientIp: () => '127.0.0.1',
    debugApiEnabled: false,
  } as unknown as RouteContext;
  return { ctx, res };
}

describe('GET /tasks/:id error serialization', () => {
  it('serializes content_length as kind=content_length, retryable=true', async () => {
    const { ctx, res } = makeGetCtx({
      id: 7,
      sourceId: 70,
      status: 'error',
      pipelineStep: 'content_validation',
      errorKind: 'content_length',
      createdAt: 1,
    });
    await handleTaskRoutes(ctx);
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    const error = jsonBody(res).error as Record<string, unknown>;
    expect(error.kind).toBe('content_length');
    expect(error.retryable).toBe(true);
  });

  it('serializes content_policy as retryable=false', async () => {
    const { ctx, res } = makeGetCtx({
      id: 8,
      sourceId: 80,
      status: 'error',
      pipelineStep: 'verifying',
      errorKind: 'content_policy',
      createdAt: 1,
    });
    await handleTaskRoutes(ctx);
    const error = jsonBody(res).error as Record<string, unknown>;
    expect(error.kind).toBe('content_policy');
    expect(error.retryable).toBe(false);
  });
});
