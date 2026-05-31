// apps/server/src/wizard-server.ts
//
// **Trust boundary**: this server has NO authentication. The trust boundary
// is the loopback interface — anything that can connect to 127.0.0.1:<port>
// is trusted to read/write the wizard config. That model holds when the
// host is **single-user** (the default Goldpan deployment target — open-
// source self-host, single operator, small team). It does NOT hold on
// multi-tenant boxes (shared dev servers, jump hosts with shared SSH
// accounts) — any local user could `curl localhost:3001/onboarding/state`
// and read or overwrite the config. Don't run the wizard on machines
// where you wouldn't trust every local user with raw `.env` write access.
//
// Defense in depth (still applies even on single-user hosts):
//   1. server.listen() bound to '127.0.0.1' (not 0.0.0.0)
//   2. per-request socket.remoteAddress check (rejects non-loopback
//      sources even if the bind were misconfigured upstream)
//   3. GOLDPAN_TRUST_PROXY is forcibly OFF — X-Forwarded-For: 127.0.0.1
//      from a remote attacker can't bypass the per-request check
//   4. Origin header check (isAllowedWizardOrigin) — rejects browser
//      requests whose Origin is not a loopback host. Defends against a
//      same-machine page on a non-loopback origin attempting wizard calls
//      (e.g. dev server bound to 0.0.0.0 reachable via LAN IP).
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WizardBootstrapHandle } from '@goldpan/core/bootstrap';
import { type LlmProviderPluginInfo, scanLlmProviderPlugins } from '@goldpan/core/plugins';
import { type ImSettingsModule, loadChannels } from '@goldpan/im-runtime';
import { isLoopbackHostname } from './lib/base-url-security.js';
import { unstickTsxWatchParent } from './lib/restart-cascade.js';
import { checkRateLimit, getRateLimitKey } from './rate-limit.js';
import { createImSettingsRoutes } from './routes/im-settings.js';
import { createCommitHandler, createCommitPreviewHandler } from './routes/onboarding/commit.js';
import { handleOnboardingLlmProvidersRoute } from './routes/onboarding/llm-providers.js';
import { handleRuntimeInfoRoute } from './routes/onboarding/runtime-info.js';
import { handleStateRoute } from './routes/onboarding/state.js';
import { handleTestProviderRoute } from './routes/onboarding/test-provider.js';
import { handleValidateRoute } from './routes/onboarding/validate.js';
import { createRestartHandler } from './routes/server/restart.js';
import { respond, respondError } from './routes/types.js';

/**
 * Plugins directory — same resolution as `im-compose.ts` so wizard mode
 * discovers IM channels from the same place normal mode does.
 */
const DEFAULT_PLUGINS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../plugins',
);

export interface RunWizardServerOptions {
  handle: WizardBootstrapHandle;
  port: number;
}

export function isLocalAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function isAllowedWizardOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Wizard mode HTTP server. Bound to localhost only, no auth, rate-limited.
 *
 * - GET /health → `{ status: 'wizard', reason }` for middleware probe.
 * - GET / PATCH /onboarding/state → in-memory wizard state.
 * - POST /onboarding/test-provider → connectivity probe.
 * - POST /onboarding/validate → strict config validation.
 * - POST /onboarding/commit → atomic .env write + metadata seed.
 * - GET /onboarding/commit-preview → preview staged env keys + full .env content (read-only).
 * - GET /onboarding/runtime-info → supervisor detection.
 * - GET /onboarding/llm-providers → builtin + custom + plugin provider list
 *   (mirrors /settings/llm-providers shape; plugin entries pre-bootstrap so
 *   status is always 'loaded' — real status comes from the main server post-
 *   onboarding).
 * - POST /server/restart → drain http server + handle.shutdown() then exit(0)
 *   so the supervisor restarts the process in normal mode.
 *
 * Returns a Promise that resolves on SIGTERM / SIGINT graceful shutdown.
 * `/server/restart` runs the same shutdown sequence inline before calling
 * `process.exit(0)`; the Promise stays unresolved on that path because the
 * process exits before it would settle, which is intentional.
 */
export async function runWizardServer(opts: RunWizardServerOptions): Promise<void> {
  const { handle, port } = opts;
  // Discover IM channel manifests so commit / commit-preview can walk them
  // without hardcoding telegram / feishu. Wizard mode runs before plugin
  // postInit, so we can't borrow the registry — load directly from disk.
  const imBundles = await loadChannels({
    pluginsDir: DEFAULT_PLUGINS_DIR,
    logger: handle.logger,
  });
  const manifests = imBundles.map((b) => b.module.manifest);
  // Pull each plugin's envKey whitelist + envSchema so the commit handler can
  // pass them through to handle.commitOverrides — same validation surface as
  // the normal-mode settings save (apps/server/src/main.ts).
  const pluginEnvKeys = imBundles.flatMap((b) => [
    b.module.manifest.enable.envKey,
    ...b.module.manifest.fields.map((f) => f.envKey),
  ]);
  const pluginEnvSchemas = imBundles.map((b) => b.envSpec.envSchema);
  let knownLlmProviderIds: string[] = [];
  try {
    knownLlmProviderIds = (await scanLlmProviderPlugins(DEFAULT_PLUGINS_DIR)).map(
      (p: LlmProviderPluginInfo) => p.providerId,
    );
  } catch {
    knownLlmProviderIds = [];
  }
  const commitHandler = createCommitHandler({
    commitOverrides: handle.commitOverrides,
    metadataRepo: handle.metadataRepo,
    hasExistingData: handle.hasExistingData,
    logger: handle.logger,
    manifests,
    pluginEnvKeys,
    pluginEnvSchemas,
    knownLlmProviderIds,
  });
  const commitPreviewHandler = createCommitPreviewHandler(manifests);

  // /settings/im/* mount — onboarding's IM step server-fetches manifests via
  // GET /settings/im/manifests, and <ImChannelCard> later requests setup-guide
  // images at /settings/im/:channelId/assets/*. Without this mount the wizard
  // page would 404 and soft-render zero channels. Build the modules map the
  // same way `composeIMRuntime` does (channelId → module from each bundle) so
  // the route handler can resolve actions/assets identically across both
  // servers. Actions endpoint is mounted too — wizard UI runs with
  // disableActions, so the route sits unused, but keeping both servers' mount
  // surfaces aligned beats a surgical-but-divergent split.
  const imModules = new Map<string, ImSettingsModule>();
  for (const b of imBundles) imModules.set(b.channelId, b.module);
  const handleImSettings = createImSettingsRoutes({
    modules: imModules,
    bundles: imBundles,
    // Wizard mode has no ConfigStore (strict loadConfig would throw on the
    // incomplete env). Actions are disabled by the wizard UI; throwing here
    // fails closed if a curl probe hits POST /settings/im/.../actions/* —
    // the dispatcher catches the throw and answers `{ ok: false, code:
    // 'internal' }`.
    getConfig: () => {
      throw new Error('IM action dispatch is unavailable in wizard mode');
    },
    logger: handle.logger,
  });

  // serverRef captured by onRestart closure below — the http server isn't
  // created until after this factory call, but the onRestart callback only
  // fires after the user POSTs /server/restart, by which point serverRef is
  // assigned. Wizard restart drains the http server and disposes the wizard
  // db handle before exiting, matching the graceful shutdown that normal mode
  // gets via main.ts's `shutdown`.
  let serverRef: http.Server | undefined;
  // Wizard mode skips auth — gated by localhost-only binding above.
  const restartHandler = createRestartHandler({
    logger: handle.logger,
    onRestart: async () => {
      if (serverRef) {
        await new Promise<void>((resolve) => {
          serverRef?.close(() => resolve());
          serverRef?.closeIdleConnections();
        });
      }
      try {
        await handle.shutdown();
      } catch (err) {
        handle.logger.error('Wizard shutdown error', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      // Dev-mode-only: SIGTERM tsx watch so its exit-0 propagates up to the
      // supervisor (which respawns into normal mode). NOOP outside dev.
      unstickTsxWatchParent();
      process.exit(0);
    },
  });

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // CRITICAL: localhost-only enforcement. Wizard mode IGNORES
    // GOLDPAN_TRUST_PROXY entirely — only the socket peer address is trusted
    // (X-Forwarded-For: 127.0.0.1 from a remote attacker can't bypass).
    const ra = req.socket.remoteAddress ?? '';
    if (!isLocalAddress(ra)) {
      req.resume();
      respondError(res, 403, 'forbidden', 'Wizard mode accepts localhost only');
      return;
    }
    if (!isAllowedWizardOrigin(req.headers.origin)) {
      req.resume();
      respondError(
        res,
        403,
        'forbidden_origin',
        'Wizard mode accepts loopback browser origins only',
      );
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://localhost:${port}`);
    } catch {
      req.resume();
      respondError(res, 400, 'invalid_url', 'Invalid request URL');
      return;
    }
    const pathname = url.pathname;

    // Rate limit (reuse central impl). trustProxy is forcibly OFF in wizard
    // mode (we never call setTrustProxy here). /health is exempt so the
    // middleware probe + post-restart polling loop aren't throttled.
    if (pathname !== '/health' && !checkRateLimit(getRateLimitKey(req))) {
      req.resume();
      respondError(res, 429, 'rate_limited', 'Too many requests');
      return;
    }

    try {
      if (pathname === '/health') {
        req.resume();
        return respond(res, 200, { status: 'wizard', reason: handle.reason });
      }
      if (pathname === '/onboarding/state') {
        return await handleStateRoute(req, res);
      }
      if (pathname === '/onboarding/test-provider' && req.method === 'POST') {
        return await handleTestProviderRoute(req, res);
      }
      if (pathname === '/onboarding/validate' && req.method === 'POST') {
        return await handleValidateRoute(req, res);
      }
      if (pathname === '/onboarding/commit' && req.method === 'POST') {
        return await commitHandler(req, res);
      }
      if (pathname === '/onboarding/commit-preview' && req.method === 'GET') {
        return commitPreviewHandler(req, res);
      }
      if (pathname === '/onboarding/runtime-info' && req.method === 'GET') {
        return handleRuntimeInfoRoute(req, res);
      }
      if (pathname === '/onboarding/llm-providers' && req.method === 'GET') {
        return await handleOnboardingLlmProvidersRoute(req, res);
      }
      if (pathname === '/server/restart' && req.method === 'POST') {
        return restartHandler(req, res);
      }
      if (pathname.startsWith('/settings/im/')) {
        return await handleImSettings(req, res, pathname);
      }
      req.resume();
      return respondError(res, 404, 'not_found', `No wizard route at ${pathname}`);
    } catch (e) {
      handle.logger.error('Wizard route error', {
        err: e instanceof Error ? e.message : String(e),
      });
      if (!res.headersSent) {
        respondError(res, 500, 'internal', 'Internal error');
      }
    }
  });

  serverRef = server;

  // Bind to 127.0.0.1 only — defense in depth alongside the per-request peer
  // address check above.
  server.listen(port, '127.0.0.1', () => {
    handle.logger.warn(
      `Wizard mode active — server is unauthenticated. Bound to 127.0.0.1:${port}.`,
    );
    handle.logger.info(
      `Open http://localhost:${port} in browser, or http://localhost:3000/onboarding if web is also running.`,
    );
  });

  return new Promise<void>((resolve) => {
    const onShutdown = (signal: string) => {
      handle.logger.info(`Wizard server received ${signal}, shutting down`);
      server.close(() => resolve());
      // Force exit if close hangs (e.g. open keep-alive sockets) within 5s
      setTimeout(() => resolve(), 5000).unref();
    };
    process.once('SIGTERM', () => onShutdown('SIGTERM'));
    process.once('SIGINT', () => onShutdown('SIGINT'));
  });
}
