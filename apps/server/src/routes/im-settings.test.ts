// apps/server/src/routes/im-settings.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GoldpanConfig } from '@goldpan/core';
import type {
  ImChannelBundle,
  ImSettingsActionContext,
  ImSettingsActionResult,
  ImSettingsModule,
} from '@goldpan/im-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createImSettingsRoutes, type ImSettingsRoutesDeps } from './im-settings.js';

/**
 * Stub the few `GoldpanConfig` fields the dispatcher actually reads
 * (currently just `language`). Cast to `GoldpanConfig` rather than building a
 * full strict config so the test stays insulated from unrelated schema
 * changes.
 */
function fakeConfig(language: 'en' | 'zh' = 'en'): GoldpanConfig {
  return { language } as unknown as GoldpanConfig;
}

function makeModule(
  channelId: string,
  handler: (ctx: ImSettingsActionContext) => Promise<ImSettingsActionResult>,
): ImSettingsModule {
  return {
    manifest: {
      channelId,
      branding: { name: { en: 'X', zh: 'X' } },
      enable: { envKey: 'X_ENABLED', label: { en: 'on', zh: '开' }, default: true },
      fields: [{ name: 'token', kind: 'secret', label: { en: 'T', zh: 'T' }, envKey: 'X_TOKEN' }],
      actions: [{ id: 'test', kind: 'test', label: { en: 'T', zh: 'T' }, requires: ['token'] }],
      setupGuide: { allDoneTitle: { en: 'D', zh: '完' }, steps: [] },
    },
    handlers: { test: handler },
  };
}

function makeBundle(module: ImSettingsModule): ImChannelBundle {
  return {
    channelId: module.manifest.channelId,
    module,
    envSpec: {
      channelId: module.manifest.channelId,
      envSchema: {},
      parse: () => ({}),
      // Returns a non-empty values map so the dispatcher reaches the handler.
      // toValues is plugin-owned; tests don't assert its shape, just that the
      // dispatcher invokes it and forwards the result via ctx.values.
      toValues: () => ({ token: 'abc' }),
    },
    registration: () => null,
    staticDir: '/tmp/none',
  };
}

function mockReq(method: string): http.IncomingMessage {
  return { method, resume: () => undefined } as unknown as http.IncomingMessage;
}

function mockJsonRes(): {
  res: http.ServerResponse;
  status: () => number;
  body: () => unknown;
} {
  let statusCode = 0;
  let bodyText = '';
  const res = {
    setHeader: () => undefined,
    writeHead: (status: number) => {
      statusCode = status;
    },
    end: (chunk?: string) => {
      bodyText = chunk ?? '';
    },
  } as unknown as http.ServerResponse;
  return {
    res,
    status: () => statusCode,
    body: () => (bodyText.length > 0 ? JSON.parse(bodyText) : null),
  };
}

async function request(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, pathname: string) => Promise<void>,
  method: string,
  reqPath: string,
  body?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        await handler(req, res, req.url ?? '/');
      } catch (err) {
        // Surface unexpected handler throws as test failures rather than
        // hanging on a never-resolved promise.
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', code: 'test_handler_threw' }));
        reject(err);
      }
    });
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('server.address() returned unexpected shape'));
        return;
      }
      const req = http.request(
        { hostname: '127.0.0.1', port: addr.port, path: reqPath, method },
        (res) => {
          let data = '';
          res.on('data', (d) => {
            data += d;
          });
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode ?? 0, body: data });
            }
          });
        },
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (body) req.write(body);
      req.end();
    });
  });
}

describe('POST /settings/im/:channelId/actions/:actionId', () => {
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Pin a clean process.env baseline so the dispatcher's plugin
    // envSpec.parse path doesn't trip on leaked dev-shell env vars (mirror
    // of settings.test.ts pattern).
    envBackup = { ...process.env };
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env = envBackup;
  });

  function buildDeps(module: ImSettingsModule): ImSettingsRoutesDeps {
    const bundle = makeBundle(module);
    return {
      modules: new Map([[module.manifest.channelId, module]]),
      bundles: [bundle],
      getConfig: () => fakeConfig('en'),
      logger: {
        warn: () => undefined,
        error: () => undefined,
      },
    };
  }

  it('returns timeout when the action handler ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const hangingModule = makeModule('demo', async () => new Promise(() => {}));
    const handler = createImSettingsRoutes(buildDeps(hangingModule));
    const resWrap = mockJsonRes();

    const pending = handler(mockReq('POST'), resWrap.res, '/settings/im/demo/actions/test').then(
      () => 'returned',
    );

    await vi.advanceTimersByTimeAsync(30_000);
    const outcome = await Promise.race([pending, Promise.resolve('still-pending')]);

    vi.useRealTimers();
    expect(outcome).toBe('returned');
    expect(resWrap.status()).toBe(200);
    expect(resWrap.body()).toEqual({ ok: false, code: 'timeout' });
  });

  it('returns 404 for unknown channel', async () => {
    const m = makeModule('demo', async () => ({ ok: true }));
    const handler = createImSettingsRoutes(buildDeps(m));
    const r = await request(handler, 'POST', '/settings/im/nope/actions/test');
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'unknown_channel' });
  });

  it('returns 404 for unknown action', async () => {
    const m = makeModule('demo', async () => ({ ok: true }));
    const handler = createImSettingsRoutes(buildDeps(m));
    const r = await request(handler, 'POST', '/settings/im/demo/actions/foo');
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'unknown_action' });
  });

  it('redacts secrets when handler throws', async () => {
    const throwingModule = makeModule('demo', async () => {
      throw new Error('token=SUPERSECRET123 invalid');
    });
    const handler = createImSettingsRoutes(buildDeps(throwingModule));
    const r = await request(handler, 'POST', '/settings/im/demo/actions/test');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: false, code: 'internal' });
    expect(JSON.stringify(r.body)).not.toContain('SUPERSECRET123');
  });

  it('passes through handler-returned message', async () => {
    const okModule = makeModule('demo', async () => ({
      ok: false,
      code: 'bad_token',
      message: 'Invalid token (no secrets here)',
    }));
    const handler = createImSettingsRoutes(buildDeps(okModule));
    const r = await request(handler, 'POST', '/settings/im/demo/actions/test');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: false,
      code: 'bad_token',
      message: 'Invalid token (no secrets here)',
    });
  });
});

describe('GET /settings/im/:channelId/assets/*', () => {
  let staticRoot: string;
  let staticDir: string;

  beforeEach(() => {
    // Real temp staticDir so the route can stat / stream a real file. Mirrors
    // what loadChannels(T5) does: an absolute, normalized path joined with
    // 'static'.
    staticRoot = mkdtempSync(path.join(tmpdir(), 'goldpan-im-assets-test-'));
    staticDir = path.join(staticRoot, 'static');
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(path.join(staticDir, 'hello.png'), 'PNGDATA');
  });

  afterEach(() => {
    rmSync(staticRoot, { recursive: true, force: true });
  });

  function buildAssetDeps(): ImSettingsRoutesDeps {
    const m = makeModule('demo', async () => ({ ok: true }));
    const bundle: ImChannelBundle = {
      channelId: 'demo',
      module: m,
      envSpec: {
        channelId: 'demo',
        envSchema: {},
        parse: () => ({}),
        toValues: () => ({}),
      },
      registration: () => null,
      staticDir,
    };
    return {
      modules: new Map([['demo', m]]),
      bundles: [bundle],
      // getConfig unused by the asset route — asset serving never invokes
      // the action dispatcher path.
      getConfig: () => fakeConfig('en'),
      logger: { warn: () => undefined, error: () => undefined },
    };
  }

  it('serves a present file', async () => {
    const handler = createImSettingsRoutes(buildAssetDeps());
    const r = await request(handler, 'GET', '/settings/im/demo/assets/hello.png');
    expect(r.status).toBe(200);
    // request() falls through to raw string when JSON.parse fails. PNGDATA is
    // ASCII so utf-8 string accumulation matches.
    expect(r.body).toBe('PNGDATA');
  });

  it('returns 403 for path traversal', async () => {
    const handler = createImSettingsRoutes(buildAssetDeps());
    // Use a path that survives URL parsing (Node's HTTP parser collapses
    // leading `..` against the URL root, but a `..` after a real segment
    // remains in pathname for our route to see).
    const r = await request(handler, 'GET', '/settings/im/demo/assets/sub/../../../etc/passwd');
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'forbidden' });
  });

  it('returns 404 for missing file', async () => {
    const handler = createImSettingsRoutes(buildAssetDeps());
    const r = await request(handler, 'GET', '/settings/im/demo/assets/nope.png');
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'not_found' });
  });
});
