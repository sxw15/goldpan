// apps/server/tests/helpers.ts
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: () => unknown;
}

export async function request(
  port: number,
  method: string,
  path: string,
  options?: {
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options?.headers,
    };
    const bodyStr = options?.body ? JSON.stringify(options.body) : undefined;

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: reqHeaders,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body),
          });
        });
      },
    );

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Reserve an ephemeral TCP port by briefly binding and then closing.
 * There is a small race between close() and the test server re-binding,
 * but it's acceptable in a single-threaded test runner.
 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

export interface StartedServer {
  port: number;
  password: string;
  process: ChildProcess;
  tmpDir: string;
  /** Gracefully stop the server and clean up its temp directory. */
  stop: () => Promise<void>;
}

export interface StartServerOptions {
  /** Override for the bearer/login password. Must be ≥8 chars per config schema. */
  password?: string;
  /** Max ms to wait for the server to answer /health. */
  startupTimeoutMs?: number;
  /** Extra GOLDPAN_* or other env vars to merge on top of the base test env. */
  envOverrides?: Record<string, string>;
}

/**
 * Spawn the standalone server in a subprocess with an isolated temp SQLite DB.
 * Used by the integration test suite so `pnpm --filter @goldpan/server test`
 * exercises real HTTP traffic instead of silently skipping.
 */
export async function startTestServer(options?: StartServerOptions): Promise<StartedServer> {
  const password = options?.password ?? 'test-password-12345';
  const startupTimeoutMs = options?.startupTimeoutMs ?? 45_000;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goldpan-server-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const port = await pickFreePort();

  // apps/server/tests/helpers.ts → apps/server
  const serverDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

  // We intentionally strip the parent shell's GOLDPAN_* vars so the .env file
  // in the monorepo root and test-supplied values define a deterministic env.
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith('GOLDPAN_')) continue;
    cleanEnv[k] = v;
  }

  const env = {
    ...cleanEnv,
    GOLDPAN_DB_SQLITE_PATH: dbPath,
    GOLDPAN_AUTH_PASSWORD: password,
    GOLDPAN_SERVER_PORT: String(port),
    // Auth password requires an explicit non-production NODE_ENV; config
    // enforces that production deployments must set auth, which is already
    // satisfied here. Setting 'test' keeps Set-Cookie non-Secure on http://
    NODE_ENV: 'test',
    // Keep the worker polling silent-ish during tests
    GOLDPAN_LOG_LEVEL: 'warn',
    // No LLM traffic in HTTP-route tests — provide a harmless default.
    GOLDPAN_LLM_CLASSIFIER: 'openai:gpt-4o-mini',
    // Wizard-mode auto-detection routes to wizard whenever a referenced
    // provider has no key (`no_provider_key`), which mounts ONLY /onboarding/*
    // and answers everything else with 404. The default classifier/extractor
    // models reference openai + anthropic, so HTTP-route tests must supply
    // dummy keys to stay on the normal-mode router. Tests never hit a real
    // LLM — the keys exist only to satisfy bootstrap's referenced-provider
    // check.
    OPENAI_API_KEY: 'sk-test-noop',
    ANTHROPIC_API_KEY: 'sk-test-noop',
    // The parent-shell GOLDPAN_* strip above is undone by main.ts re-loading
    // monorepo/.env inside the spawned child. If a developer's local .env has
    // real Telegram / Feishu credentials, the IM runtime would actually start
    // long-polling against those channels for every spawned test server —
    // causing /health to flap to `degraded` (the bot token can only hold one
    // long-polling client, so concurrent test files race) or hold real
    // network sockets open. HTTP-route tests do not need IM; suites that
    // exercise IM wiring run in-process or opt back in via envOverrides.
    GOLDPAN_IM_TELEGRAM_ENABLED: 'false',
    GOLDPAN_IM_FEISHU_ENABLED: 'false',
    ...(options?.envOverrides ?? {}),
  };

  const child = spawn('pnpm', ['exec', 'tsx', 'src/main.ts'], {
    cwd: serverDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  const stderrChunks: string[] = [];
  child.stderr?.on('data', (chunk) => {
    stderrChunks.push(chunk.toString());
  });
  child.stdout?.on('data', () => {
    // Keep stdout drained so the child does not block on a full pipe buffer.
  });

  type EarlyExit = { code: number | null; signal: NodeJS.Signals | null };
  // Held in a single-element array so TS doesn't narrow the closed-over `let`
  // back to `null` after the async `child.once('exit')` callback assigns it.
  const earlyExit: [EarlyExit | null] = [null];
  child.once('exit', (code, signal) => {
    earlyExit[0] = { code, signal };
  });

  const start = Date.now();
  while (Date.now() - start < startupTimeoutMs) {
    const exit = earlyExit[0];
    if (exit) {
      throw new Error(
        `Test server exited before becoming healthy (code=${exit.code}, signal=${exit.signal})\nstderr:\n${stderrChunks.join('')}`,
      );
    }
    try {
      const res = await request(port, 'GET', '/health');
      // 200 = healthy, 503 = bootstrapping/DB not ready — both mean the HTTP
      // listener is up, so subsequent requests can be sent. We accept both.
      if (res.status === 200 || res.status === 503) {
        return {
          port,
          password,
          process: child,
          tmpDir,
          stop: () => stopServer(child, tmpDir),
        };
      }
    } catch {
      // Not yet listening — sleep and retry.
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  await stopServer(child, tmpDir);
  throw new Error(
    `Test server did not become healthy within ${startupTimeoutMs}ms\nstderr:\n${stderrChunks.join('')}`,
  );
}

async function stopServer(child: ChildProcess, tmpDir: string): Promise<void> {
  if (!child.killed && child.exitCode === null) {
    child.kill('SIGTERM');
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) child.kill('SIGKILL');
  }
  if (fs.existsSync(tmpDir)) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; leaving a temp dir behind is not a test failure
    }
  }
}
