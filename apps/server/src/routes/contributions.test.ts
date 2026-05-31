// apps/server/src/routes/contributions.test.ts
//
// Integration test for the generic /settings/contributions endpoint —
// boots an ephemeral HTTP server, registers a couple of contributions on
// a real PluginRegistry, then asserts the wire-format response shape.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GoldpanConfig } from '@goldpan/core/config';
import {
  type PluginActionContext,
  type PluginActionHandler,
  PluginRegistry,
} from '@goldpan/core/plugins';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createContributionsRoutes } from './contributions.js';

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

function fakeConfig(language: 'en' | 'zh' = 'en'): GoldpanConfig {
  return { language } as unknown as GoldpanConfig;
}

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function request(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<void>,
  method: string,
  reqPath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url ?? '/', 'http://127.0.0.1');
        await handler(req, res, u);
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ code: 'test_threw' }));
        reject(err);
      }
    });
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('bad addr'));
        return;
      }
      const r = http.request(
        {
          hostname: '127.0.0.1',
          port: addr.port,
          path: reqPath,
          method,
          ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' } } : {}),
        },
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
      r.on('error', reject);
      r.end(body !== undefined ? JSON.stringify(body) : undefined);
    });
  });
}

function registerSample(registry: PluginRegistry, handler?: PluginActionHandler): void {
  registry.registerSettingsContribution(
    {
      pluginId: 'demo',
      group: 'search',
      branding: { name: { en: 'Demo', zh: '演示' } },
      schema: z.object({
        apiKey: z.string().min(1),
        mode: z.enum(['quick', 'deep']),
      }),
      fields: [
        {
          name: 'apiKey',
          kind: 'secret',
          envKey: 'DEMO_API_KEY',
          label: { en: 'API Key', zh: '密钥' },
        },
        {
          name: 'mode',
          kind: 'segmented',
          envKey: 'DEMO_MODE',
          label: { en: 'Mode', zh: '模式' },
          options: [
            { value: 'quick', label: { en: 'Quick', zh: '快速' } },
            { value: 'deep', label: { en: 'Deep', zh: '深度' } },
          ],
          default: 'quick',
        },
      ],
      actions: [
        {
          id: 'test',
          kind: 'test',
          label: { en: 'Test', zh: '测试' },
          errorMessages: { unauth: { en: 'Bad key', zh: '密钥错误' } },
        },
      ],
    },
    {
      test: handler ?? (async () => ({ ok: true, data: { sentinel: 'reached' } })),
    },
  );
}

describe('GET /settings/contributions', () => {
  it('returns flat strings resolved for the requested locale', async () => {
    const registry = new PluginRegistry();
    registerSample(registry);
    const handler = createContributionsRoutes({
      pluginRegistry: registry,
      getConfig: () => fakeConfig('en'),
      logger: noopLogger,
    });

    const { status, body } = await request(handler, 'GET', '/settings/contributions?locale=zh');

    expect(status).toBe(200);
    const payload = body as { contributions: unknown[] };
    expect(payload.contributions).toHaveLength(1);
    const c = payload.contributions[0] as {
      pluginId: string;
      branding: { name: string };
      fields: { name: string; label: string; options?: { value: string; label: string }[] }[];
      actions: { id: string; label: string; errorMessages?: Record<string, string> }[];
    };
    expect(c.pluginId).toBe('demo');
    expect(c.branding.name).toBe('演示');
    expect(c.fields[0]?.label).toBe('密钥');
    expect(c.fields[1]?.options).toEqual([
      { value: 'quick', label: '快速' },
      { value: 'deep', label: '深度' },
    ]);
    expect(c.actions[0]?.label).toBe('测试');
    expect(c.actions[0]?.errorMessages?.unauth).toBe('密钥错误');
  });

  it('defaults to server effective language when no locale param', async () => {
    const registry = new PluginRegistry();
    registerSample(registry);
    const handler = createContributionsRoutes({
      pluginRegistry: registry,
      getConfig: () => fakeConfig('zh'),
      logger: noopLogger,
    });

    const { body } = await request(handler, 'GET', '/settings/contributions');
    const c = (body as { contributions: { branding: { name: string } }[] }).contributions[0];
    expect(c?.branding.name).toBe('演示');
  });
});

describe('POST /settings/contributions/:pluginId/actions/:actionId', () => {
  it('returns timeout when the action handler ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const registry = new PluginRegistry();
    registerSample(registry, async () => new Promise(() => {}));
    const handler = createContributionsRoutes({
      pluginRegistry: registry,
      getConfig: () => fakeConfig('en'),
      readBody: async () => JSON.stringify({ values: { apiKey: 'sk-test', mode: 'quick' } }),
      logger: noopLogger,
    });
    const resWrap = mockJsonRes();

    const pending = handler(
      mockReq('POST'),
      resWrap.res,
      new URL('http://127.0.0.1/settings/contributions/demo/actions/test'),
    ).then(() => 'returned');

    await vi.advanceTimersByTimeAsync(30_000);
    const outcome = await Promise.race([pending, Promise.resolve('still-pending')]);

    vi.useRealTimers();
    expect(outcome).toBe('returned');
    expect(resWrap.status()).toBe(200);
    expect(resWrap.body()).toEqual({ ok: false, code: 'timeout' });
  });

  it('dispatches to the registered action handler with resolved values', async () => {
    const registry = new PluginRegistry();
    process.env.DEMO_API_KEY = 'sk-test';
    process.env.DEMO_MODE = 'deep';
    let captured: Record<string, unknown> | null = null;
    registerSample(registry, async (ctx: PluginActionContext) => {
      captured = { ...ctx.values, locale: ctx.locale };
      return { ok: true, data: { ok: 1 } };
    });
    const handler = createContributionsRoutes({
      pluginRegistry: registry,
      getConfig: () => fakeConfig('en'),
      logger: noopLogger,
    });

    const { status, body } = await request(
      handler,
      'POST',
      '/settings/contributions/demo/actions/test',
    );

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, data: { ok: 1 } });
    expect(captured).toEqual({ apiKey: 'sk-test', mode: 'deep', locale: 'en' });

    delete process.env.DEMO_API_KEY;
    delete process.env.DEMO_MODE;
  });

  it('merges current form values from the request body before dispatching', async () => {
    const registry = new PluginRegistry();
    process.env.DEMO_API_KEY = 'old-key';
    process.env.DEMO_MODE = 'quick';
    let captured: Record<string, unknown> | null = null;
    registerSample(registry, async (ctx: PluginActionContext) => {
      captured = { ...ctx.values };
      return { ok: true };
    });
    const handler = createContributionsRoutes({
      pluginRegistry: registry,
      getConfig: () => fakeConfig('en'),
      logger: noopLogger,
    });

    const { status, body } = await request(
      handler,
      'POST',
      '/settings/contributions/demo/actions/test',
      { values: { apiKey: 'new-key', mode: 'deep' } },
    );

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(captured).toEqual({ apiKey: 'new-key', mode: 'deep' });

    delete process.env.DEMO_API_KEY;
    delete process.env.DEMO_MODE;
  });

  it('does not dispatch when the injected body reader rejects the request', async () => {
    const registry = new PluginRegistry();
    const actionHandler = vi.fn(async () => ({ ok: true as const }));
    registerSample(registry, actionHandler);
    const handler = createContributionsRoutes({
      pluginRegistry: registry,
      getConfig: () => fakeConfig('en'),
      logger: noopLogger,
      readBody: async (req: http.IncomingMessage, res: http.ServerResponse) => {
        req.resume();
        res.writeHead(413);
        res.end(JSON.stringify({ type: 'error', code: 'too_large' }));
        return null;
      },
    } as Parameters<typeof createContributionsRoutes>[0] & {
      readBody: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<string | null>;
    });

    const { status, body } = await request(
      handler,
      'POST',
      '/settings/contributions/demo/actions/test',
      { values: { apiKey: 'new-key', mode: 'deep' } },
    );

    expect(status).toBe(413);
    expect((body as { code: string }).code).toBe('too_large');
    expect(actionHandler).not.toHaveBeenCalled();
  });

  it('rejects non-finite number values as invalid_body instead of leaking NaN', async () => {
    const registry = new PluginRegistry();
    registry.registerSettingsContribution(
      {
        pluginId: 'numeric',
        group: 'search',
        branding: { name: 'Numeric' },
        schema: z.object({ hourlyLimit: z.number().int().min(1).max(1000).optional() }),
        fields: [
          {
            name: 'hourlyLimit',
            kind: 'number',
            envKey: 'NUMERIC_HOURLY_LIMIT',
            label: 'Hourly limit',
          },
        ],
        actions: [{ id: 'test', kind: 'test', label: 'Test' }],
      },
      { test: async () => ({ ok: true }) },
    );
    const handler = createContributionsRoutes({
      pluginRegistry: registry,
      getConfig: () => fakeConfig('en'),
      logger: noopLogger,
    });

    const { status, body } = await request(
      handler,
      'POST',
      '/settings/contributions/numeric/actions/test',
      { values: { hourlyLimit: 'abc' } },
    );

    expect(status).toBe(400);
    expect((body as { code: string }).code).toBe('invalid_body');
  });

  it('rejects object values instead of stringifying them for text-like fields', async () => {
    const registry = new PluginRegistry();
    const actionHandler = vi.fn(async () => ({ ok: true as const }));
    registerSample(registry, actionHandler);
    const handler = createContributionsRoutes({
      pluginRegistry: registry,
      getConfig: () => fakeConfig('en'),
      logger: noopLogger,
    });

    const { status, body } = await request(
      handler,
      'POST',
      '/settings/contributions/demo/actions/test',
      { values: { apiKey: { nested: true }, mode: 'deep' } },
    );

    expect(status).toBe(400);
    expect((body as { code: string }).code).toBe('invalid_body');
    expect(actionHandler).not.toHaveBeenCalled();
  });

  it('returns a validation result instead of dispatching invalid current form values', async () => {
    const registry = new PluginRegistry();
    const actionHandler = vi.fn(async () => ({ ok: true as const }));
    registerSample(registry, actionHandler);
    const handler = createContributionsRoutes({
      pluginRegistry: registry,
      getConfig: () => fakeConfig('en'),
      logger: noopLogger,
    });

    const { status, body } = await request(
      handler,
      'POST',
      '/settings/contributions/demo/actions/test',
      { values: { apiKey: 'new-key', mode: 'invalid-mode' } },
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, code: 'validation' });
    expect(actionHandler).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown plugin', async () => {
    const registry = new PluginRegistry();
    const handler = createContributionsRoutes({
      pluginRegistry: registry,
      getConfig: () => fakeConfig('en'),
      logger: noopLogger,
    });
    const { status, body } = await request(
      handler,
      'POST',
      '/settings/contributions/ghost/actions/test',
    );
    expect(status).toBe(404);
    expect((body as { code: string }).code).toBe('unknown_plugin');
  });

  it('returns 404 for unknown action', async () => {
    const registry = new PluginRegistry();
    registerSample(registry);
    const handler = createContributionsRoutes({
      pluginRegistry: registry,
      getConfig: () => fakeConfig('en'),
      logger: noopLogger,
    });
    const { status, body } = await request(
      handler,
      'POST',
      '/settings/contributions/demo/actions/nonexistent',
    );
    expect(status).toBe(404);
    expect((body as { code: string }).code).toBe('unknown_action');
  });

  it('redacts handler exceptions to a generic internal code', async () => {
    const registry = new PluginRegistry();
    process.env.DEMO_API_KEY = 'sk-test';
    process.env.DEMO_MODE = 'deep';
    registerSample(registry, async () => {
      throw new Error('secret-laden message');
    });
    const handler = createContributionsRoutes({
      pluginRegistry: registry,
      getConfig: () => fakeConfig('en'),
      logger: noopLogger,
    });
    const { status, body } = await request(
      handler,
      'POST',
      '/settings/contributions/demo/actions/test',
    );
    expect(status).toBe(200);
    expect(body).toEqual({ ok: false, code: 'internal' });
    delete process.env.DEMO_API_KEY;
    delete process.env.DEMO_MODE;
  });
});

describe('GET /settings/contributions/:pluginId/assets/:path', () => {
  it('serves assets from the plugin asset directory', async () => {
    const registry = new PluginRegistry();
    registerSample(registry);
    const dir = mkdtempSync(path.join(tmpdir(), 'contribution-assets-'));
    writeFileSync(path.join(dir, 'guide.svg'), '<svg />');
    const handler = createContributionsRoutes({
      pluginRegistry: registry,
      getConfig: () => fakeConfig('en'),
      getAssetDir: (pluginId) => (pluginId === 'demo' ? dir : undefined),
      logger: noopLogger,
    });

    const { status, body } = await request(
      handler,
      'GET',
      '/settings/contributions/demo/assets/guide.svg',
    );

    expect(status).toBe(200);
    expect(body).toBe('<svg />');
    rmSync(dir, { recursive: true, force: true });
  });
});
