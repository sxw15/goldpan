import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request, type StartedServer, startTestServer } from './helpers';

// describe.skipIf keeps beforeAll/afterAll scoped to the gate — without that,
// vitest would spawn the real server subprocess + mock HTTP server even when
// GOLDPAN_LLM_TEST_STUB is not set. The smoke test only makes sense when a
// caller supplies LLM stubs capable of driving the 9-step pipeline to
// completion against the canned GitHub REST responses below.
describe.skipIf(!process.env.GOLDPAN_LLM_TEST_STUB)('github pipeline end-to-end', () => {
  let mock: http.Server;
  let mockUrl: string;
  let server: StartedServer;

  beforeAll(async () => {
    mock = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/repos/o/r/readme')) {
        res.end(
          JSON.stringify({
            content: Buffer.from(
              '# Repo\n![badge](https://img.shields.io/badge/x-y-z)\nHello world.',
            ).toString('base64'),
            encoding: 'base64',
          }),
        );
        return;
      }
      if (req.url?.startsWith('/repos/o/r/releases')) {
        res.end('[]');
        return;
      }
      if (req.url?.startsWith('/repos/o/r/commits')) {
        res.end('[]');
        return;
      }
      if (req.url?.startsWith('/repos/o/r/contents/CHANGELOG')) {
        res.statusCode = 404;
        res.end('{"message":"Not Found"}');
        return;
      }
      if (req.url?.startsWith('/repos/o/r')) {
        res.end(
          JSON.stringify({
            id: 1,
            name: 'r',
            full_name: 'o/r',
            owner: { login: 'o' },
            default_branch: 'main',
            archived: false,
            description: 'demo',
            pushed_at: '2026-04-19T00:00:00Z',
            stargazers_count: 1,
            forks_count: 0,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{"message":"Not Found"}');
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
    const port = (mock.address() as AddressInfo).port;
    mockUrl = `http://127.0.0.1:${port}`;

    server = await startTestServer({
      startupTimeoutMs: 60_000,
      envOverrides: {
        GOLDPAN_GITHUB_API_BASE: mockUrl,
        GOLDPAN_GITHUB_TOKEN: 'test-token',
      },
    });
  }, 90_000);

  afterAll(async () => {
    await server?.stop();
    await new Promise<void>((r) => mock?.close(() => r()));
  });

  const authHeaders = () => ({ Authorization: `Bearer ${server.password}` });

  async function waitForTaskCompletion(taskId: number, timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await request(server.port, 'GET', `/tasks/${taskId}`, {
        headers: authHeaders(),
      });
      if (res.status === 200) {
        const body = res.json() as { status?: string };
        if (body.status === 'completed' || body.status === 'failed') return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Task ${taskId} did not reach a terminal status within ${timeoutMs}ms`);
  }

  it('submits a github URL, runs the pipeline, and refreshes without shields.io leaks', async () => {
    const submit = await request(server.port, 'POST', '/input', {
      headers: authHeaders(),
      body: { input: 'https://github.com/o/r' },
    });
    expect([200, 201]).toContain(submit.status);
    const submitBody = submit.json() as { taskId?: number };
    expect(typeof submitBody.taskId).toBe('number');
    await waitForTaskCompletion(submitBody.taskId as number);

    const state = await request(server.port, 'GET', '/github/state?owner=o&repo=r', {
      headers: authHeaders(),
    });
    expect(state.status).toBe(200);
    const stateBody = state.json() as { data: { refreshCount: number } | null };
    expect(stateBody.data?.refreshCount).toBeGreaterThanOrEqual(1);

    const refresh = await request(server.port, 'POST', '/github/refresh-by-url', {
      headers: authHeaders(),
      body: { normalizedUrl: 'https://github.com/o/r' },
    });
    expect(refresh.status).toBe(200);
    const refreshBody = refresh.json() as { status: string };
    expect(['started', 'too_recent']).toContain(refreshBody.status);
  });
});
