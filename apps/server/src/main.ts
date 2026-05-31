import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ConversationContext,
  type ConversationListItem,
  type ConversationMessageRecord,
  extractAssistantTurn,
  findAndMergeBuffered,
  reconcileExpiredBufferedBySession,
  stripInternalKeys,
} from '@goldpan/core/conversation';
import {
  ConversationNotFoundError,
  SqliteRuntimeConfigOverrideRepository,
} from '@goldpan/core/db/repositories';
import { t } from '@goldpan/core/i18n';
import {
  buildContributionEnvSchema,
  type LlmProviderPlugin,
  type SettingsContributionRegistration,
} from '@goldpan/core/plugins';
import { config as loadEnv } from 'dotenv';

// Load .env from monorepo root before any @goldpan/core imports
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(__dirname, '../../..');
loadEnv({ path: path.join(monorepoRoot, '.env') });

// Frozen baseline. Anything saved via UI overrides (DB) is layered on top
// inside ConfigStore. See packages/core/src/config/store.ts.
const BOOT_ENV_SNAPSHOT: Readonly<NodeJS.ProcessEnv> = Object.freeze({ ...process.env });

const { bootstrap, isWizardHandle } = await import('@goldpan/core/bootstrap');
const { submitInput } = await import('@goldpan/core/submit');
const { handleInput } = await import('@goldpan/core/input');
const { queryKnowledge, MAX_QUERY_LENGTH } = await import('@goldpan/core/query');

import { verifyAuth } from './auth.js';
import { handleCors, parseCorsOrigins } from './cors.js';
import { buildHealthResponse, dualProcessConfigHash } from './health.js';
import { composeIMRuntime } from './im-compose.js';
import { unstickTsxWatchParent } from './lib/restart-cascade.js';
import { checkRateLimit, getRateLimitKey, setTrustProxy } from './rate-limit.js';
import { handleAuthRoutes } from './routes/auth.js';
import {
  handleBufferedCancel,
  handleBufferedRelease,
  scheduleReconcileForConversation,
  scheduleReconcileForSession,
} from './routes/buffered.js';
import { createContributionsRoutes } from './routes/contributions.js';
import { handleDebugRoutes } from './routes/debug.js';
import { handleDigestRoutes } from './routes/digest.js';
import { createImSettingsRoutes } from './routes/im-settings.js';
import { serializeHandleInputResult, submitStatusToHttp } from './routes/input-wire.js';
import { handleKnowledgeRoutes } from './routes/knowledge.js';
import { createLlmProvidersRoute } from './routes/llm-providers.js';
import { handleNoteRoutes } from './routes/notes.js';
import { detectSupervisor } from './routes/onboarding/runtime-info.js';
import { createPluginsRoute } from './routes/plugins.js';
import { createRestartHandler } from './routes/server/restart.js';
import { createSettingsRoutes } from './routes/settings.js';
import { handleSourceRoutes } from './routes/sources.js';
import { handleTaskRoutes } from './routes/tasks.js';
import { handleTrackingRoutes } from './routes/tracking.js';
import { parseJsonBody, parsePositiveIntParam, respondError } from './routes/types.js';
import { handleUserNoteRoutes } from './routes/user-notes.js';

const DEFAULT_PORT = 3001;
const MAX_BODY_BYTES = 1_000_000;
const BODY_READ_TIMEOUT_MS = 30_000;
const DEFAULT_INPUT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_QUERY_TIMEOUT_MS = 3 * 60_000;
const MIN_RECOMMENDED_SOCKET_TIMEOUT_MS = 5 * 60_000;
const WEB_CHANNEL_ID = 'web';

import { WEB_SESSION_KEY } from './routes/buffered.js';

// --- Github API duck-typed interfaces ---
interface GithubRefreshResultWire {
  status: string;
  sourceId?: number;
  taskId?: number;
  startedAt?: number;
  retryAfterSeconds?: number;
  lastRefreshedAt?: number;
  resetsAt?: number;
  archivedAt?: number | null;
}
interface GithubServiceAPI {
  refreshRepo(args: { owner: string; repo: string }): Promise<GithubRefreshResultWire>;
  refreshRepoByNormalizedUrl(normalizedUrl: string): Promise<GithubRefreshResultWire>;
  getRepoState(args: { owner: string; repo: string }): unknown;
}

const TOO_LARGE_PAYLOAD = JSON.stringify({
  type: 'error',
  code: 'too_large',
  message: 'Request too large',
});

/** Read POST body with a size limit and a per-request deadline to prevent slow-loris attacks. */
async function readBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;

    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buf.length;
      if (byteLength > MAX_BODY_BYTES) {
        settled = true;
        clearTimeout(timer);
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
        res.writeHead(413);
        res.end(TOO_LARGE_PAYLOAD);
        req.on('error', () => {});
        req.resume();
        resolve(null);
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf-8'));
    };

    const onError = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      if (!res.headersSent) {
        res.writeHead(400);
        res.end(
          JSON.stringify({ type: 'error', code: 'request_error', message: 'Request read error' }),
        );
      }
      req.on('error', () => {});
      req.resume();
      resolve(null);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      if (!res.headersSent) {
        res.writeHead(408);
        res.end(JSON.stringify({ type: 'error', code: 'timeout', message: 'Request timeout' }));
      }
      req.on('error', () => {});
      req.resume();
      resolve(null);
    }, BODY_READ_TIMEOUT_MS);

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

// Plugins shipped via npm dependency rather than `plugins/<name>/dist`
// (e.g. `@goldpan/plugin-collector-media`) need composition-layer registration
// — `loadExternalPlugins` only sees the filesystem, which is empty after
// `pnpm deploy`.
async function loadAdditionalPlugins() {
  const { collectorMediaPlugin } = await import('@goldpan/plugin-collector-media');
  return [collectorMediaPlugin];
}

// --- CLI: submit mode ---
const args = process.argv.slice(2);
if (args[0] === 'submit' && args[1]) {
  const rawInput = args.slice(1).join(' ');
  // Submit is a one-shot CLI: must fail fast on bad config rather than silently
  // dropping into wizard mode (which makes no sense for a non-interactive command).
  const additionalPlugins = await loadAdditionalPlugins();
  const handle = await bootstrap({
    skipWorker: true,
    mode: 'normal',
    additionalPlugins,
    bootEnv: BOOT_ENV_SNAPSHOT,
  });
  if (isWizardHandle(handle)) {
    // Unreachable with mode: 'normal' — but the type guard is the discriminator.
    console.error('Submit cannot run in wizard mode');
    await handle.shutdown();
    process.exit(1);
  }
  let exitCode = 0;
  try {
    const result = await submitInput(rawInput, {
      db: handle.db,
      submissionLog: handle.repos.submissionLog,
      // hot-read: maxTextInputLength is a no-restart setting, so the entry gate
      // reads the live snapshot (ssrf stays on frozen handle.config — it's a
      // STATIC_RESTART_REQUIRED_KEY).
      maxTextInputLength: handle.configStore.getSnapshot().config.maxTextInputLength,
      ssrfValidationEnabled: handle.config.ssrfValidationEnabled,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Submit failed:', err instanceof Error ? err.message : String(err));
    exitCode = 1;
  } finally {
    await handle.shutdown();
  }
  process.exit(exitCode);
}

// --- CLI: yt-dlp binary management ---
if (args[0] === 'yt-dlp' && args[1]) {
  const { binaryManagerApi } = await import('@goldpan/plugin-collector-media');
  const { resolveProjectRoot } = await import('@goldpan/core/config');
  // 与运行时 loadConfig() 同样的解析方式 — 否则 CLI 写到 cwd-relative 路径，
  // server 跑时却用 projectRoot-relative，安装位置和读取位置错位
  const projectRoot = resolveProjectRoot();
  const dbPathEnv = process.env.GOLDPAN_DB_SQLITE_PATH;
  const dbPath = dbPathEnv
    ? path.isAbsolute(dbPathEnv)
      ? dbPathEnv
      : path.resolve(projectRoot, dbPathEnv)
    : path.resolve(projectRoot, './data/goldpan.db');
  const ytDlpDirEnv = process.env.GOLDPAN_YT_DLP_DIR;
  const binaryDir = ytDlpDirEnv
    ? path.isAbsolute(ytDlpDirEnv)
      ? ytDlpDirEnv
      : path.resolve(projectRoot, ytDlpDirEnv)
    : path.join(path.dirname(dbPath), 'yt-dlp');

  const sub = args[1];
  let exitCode = 0;
  try {
    if (sub === 'install') {
      const versionFlag = args.find((a) => a.startsWith('--version='));
      const versionRaw = versionFlag?.split('=')[1]?.trim();
      if (versionFlag !== undefined) {
        if (!versionRaw || !/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(versionRaw)) {
          console.error(
            `Invalid --version: ${JSON.stringify(versionRaw ?? '')}. Expected YYYY.MM.DD or YYYY.MM.DD.N`,
          );
          process.exit(1);
        }
      }
      await binaryManagerApi.install({ binaryDir, version: versionRaw });
      console.log(`yt-dlp installed to ${binaryDir}`);
    } else if (sub === 'upgrade') {
      const result = await binaryManagerApi.upgrade({ binaryDir });
      console.log(
        result.upgraded
          ? `yt-dlp upgraded to ${result.version} in ${binaryDir}`
          : `yt-dlp already at ${result.version} (no upgrade needed)`,
      );
    } else if (sub === 'status') {
      const status = await binaryManagerApi.status({ binaryDir });
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.error('Usage: goldpan yt-dlp install|upgrade|status [--version=YYYY.MM.DD]');
      exitCode = 1;
    }
  } catch (err) {
    console.error('yt-dlp command failed:', err instanceof Error ? err.message : String(err));
    exitCode = 1;
  }
  process.exit(exitCode);
}

// --- Server mode ---

// Resolve port before bootstrap so both wizard and normal branches share the
// same env-validation path. `GOLDPAN_SERVER_PORT` is server-specific and
// intentionally not part of core's envSchema (which only covers config shared
// across all deployment modes).
const portEnv = process.env.GOLDPAN_SERVER_PORT;
let port = DEFAULT_PORT;
if (portEnv !== undefined && portEnv !== '') {
  const parsed = Number(portEnv);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid GOLDPAN_SERVER_PORT: "${portEnv}" (must be integer 1–65535)`);
  }
  port = parsed;
}

const additionalPlugins = await loadAdditionalPlugins();
const bootstrapResult = await bootstrap({
  mode: 'auto',
  additionalPlugins,
  bootEnv: BOOT_ENV_SNAPSHOT,
});
if (isWizardHandle(bootstrapResult)) {
  const { runWizardServer } = await import('./wizard-server.js');
  await runWizardServer({ handle: bootstrapResult, port });
  await bootstrapResult.shutdown();
  process.exit(0);
}
// Below this line, TS narrows bootstrapResult to BootstrapHandle.
const handle = bootstrapResult;
const githubService = handle.pluginRegistry.getService<GithubServiceAPI>('github');

// IM Runtime composition is delegated to `composeIMRuntime` so the wiring (telegram-enabled
// branch, secret resolution, register/start, start-failure tolerance) is unit-testable
// independently from this server entry point. See `im-compose.ts` for the behaviour
// contract — notably that a failed `runtime.start()` still returns the runtime (so /health
// and shutdown both observe the failed channel state).
const imResult = await composeIMRuntime(handle);
const imRuntime = imResult.runtime;

// P4: deferredResolver / clarify-timeout-watcher 通过 attachImSendOutbound 反向
// 拿到 IM outbound 通道；core 包不直接 import @goldpan/im-runtime。imRuntime===null
// 时（无 IM 通道）不 attach，resolver 仅落 conversation_messages。
// 显式参数类型：bootstrap.d.ts 用相对 import 引 ImSendOutbound，NodeNext 模式下
// 跨包解析不到，导致 inline callback 推断成 any。直接套 sendOutbound 的签名同义。
if (imRuntime) {
  const runtimeRef = imRuntime;
  handle.attachImSendOutbound(
    async (
      channelId: Parameters<typeof runtimeRef.sendOutbound>[0],
      ref: Parameters<typeof runtimeRef.sendOutbound>[1],
      result: Parameters<typeof runtimeRef.sendOutbound>[2],
    ) => {
      await runtimeRef.sendOutbound(channelId, ref, result);
    },
  );
}

// Settings routes are wired through `configStore` (DB-backed runtime overrides)
// rather than the legacy `.env`-write path. Handler is built once and reused
// per request — `createSettingsRoutes` returns a stable closure.
//
// Plugin envKeys + schemas come from imResult.bundles + every plugin's
// `settingsContribution` so settings UI can read / write / validate
// plugin-managed keys (e.g. GOLDPAN_IM_FEISHU_DOMAIN, TAVILY_API_KEY) without
// core needing to know about them. Each plugin contributes:
//   - enable.envKey + every fields[].envKey → managed-key whitelist
//   - IM envSpec.envSchema → strict zod validation before commit (IM only;
//     generic contributions enforce schema themselves at field level)
//
// Sources overlap (IM channels register a contribution too via the adapter in
// composeIMRuntime). We dedupe with a Set so configStore's pluginEnvKeys list
// doesn't carry duplicates, which would make later allKeys append-only logic
// noisier in logs but functionally equivalent.
const pluginEnvKeySet = new Set<string>();
for (const b of imResult.bundles) {
  pluginEnvKeySet.add(b.module.manifest.enable.envKey);
  for (const f of b.module.manifest.fields) pluginEnvKeySet.add(f.envKey);
}
for (const r of handle.pluginRegistry.getSettingsContributions()) {
  if (r.contribution.enable !== undefined) pluginEnvKeySet.add(r.contribution.enable.envKey);
  for (const f of r.contribution.fields) pluginEnvKeySet.add(f.envKey);
}
const pluginEnvKeys = [...pluginEnvKeySet];
const imContributionIds = new Set(imResult.bundles.map((b) => b.channelId));
const contributionEnvSchemas = handle.pluginRegistry
  .getSettingsContributions()
  .filter((r: SettingsContributionRegistration) => !imContributionIds.has(r.contribution.pluginId))
  .map((r: SettingsContributionRegistration) => buildContributionEnvSchema(r.contribution));
const pluginEnvSchemas = [
  ...imResult.bundles.map((b) => b.envSpec.envSchema),
  ...contributionEnvSchemas,
];
// Bootstrap creates the ConfigStore before composeIMRuntime, so its whitelist
// only sees core's MANAGED_ENV_KEYS at that point. Splice the plugin-managed
// keys in now so subsequent `commit()` calls (settings UI / programmatic) accept
// plugin envKeys, and so any DB override saved before this run for a key
// outside MANAGED_ENV_KEYS gets reapplied to process.env / snapshot.
handle.configStore.setPluginEnvKeys(pluginEnvKeys);

// Boot-EFFECTIVE env snapshot: `process.env` AFTER bootstrap merged the DB
// runtime overrides on top of the `.env` baseline (ConfigStore applied them at
// creation, and the setPluginEnvKeys call above re-applied any plugin-managed
// keys). This is what THIS server process's boot-frozen readers (e.g.
// `handle.config`) actually loaded, so it's the right baseline for the restart-
// pending comparison in createSettingsRoutes: a restart-required key is
// "pending" only when its committed value differs from what this process is
// already running. (The separate web process has its own frozen state this
// can't model; dual-process keys lean on DUAL_PROCESS_RESTART_KEYS for that.)
// Captured here, NOT at BOOT_ENV_SNAPSHOT (line ~32) which is the pre-merge
// `.env`/OS snapshot — keeping the two separate so a DB-only override still
// reads as `source: 'override'` (BOOT_ENV_SNAPSHOT drives that), while the
// restart check sees the merged value (this) and resolves on revert. Frozen so
// later `process.env` mutations from commits can't retroactively shift the
// boot baseline.
const BOOT_EFFECTIVE_ENV_SNAPSHOT: Readonly<NodeJS.ProcessEnv> = Object.freeze({ ...process.env });

// Process-lifetime accumulator of restart-required keys whose post-commit
// effective value still diverges from the boot env baseline. `/health`
// reflects this Set so external monitors / the web UI can keep nagging the
// user "you saved a boot-only key, restart pending". Two callbacks keep it
// consistent: `onPendingRestart` adds keys whose new value diverges from
// boot; `onResolveRestart` removes keys the user has reverted back to boot
// (e.g. by clicking Reset). Without the resolve path, the Set would only
// grow and `/health` would report keys as pending forever even after a
// revert. Reset to empty on next process start (the new process boots with
// merged values already in `process.env`, so nothing is "pending" anymore).
const pendingRestartKeysSet = new Set<string>();

const handleSettingsRoutes = createSettingsRoutes({
  configStore: handle.configStore,
  bootEnv: BOOT_ENV_SNAPSHOT,
  bootEffectiveEnv: BOOT_EFFECTIVE_ENV_SNAPSHOT,
  pluginEnvKeys,
  pluginEnvSchemas,
  knownLlmProviderIds: handle.pluginRegistry
    .getLlmProviderPlugins()
    .map((p: LlmProviderPlugin) => p.providerId),
  runtimeConfigOverrideRepo: new SqliteRuntimeConfigOverrideRepository(handle.db),
  onPendingRestart: (keys) => {
    for (const k of keys) pendingRestartKeysSet.add(k);
  },
  onResolveRestart: (keys) => {
    for (const k of keys) pendingRestartKeysSet.delete(k);
  },
});

const handleLlmProvidersRoute = createLlmProvidersRoute({
  pluginRegistry: handle.pluginRegistry,
  // Pull config per-request — `configStore.commit` (custom-provider declarations
  // via `GOLDPAN_LLM_PROVIDER_<ID>_*`) updates the snapshot synchronously, so
  // reading at request time keeps the listed providers in sync without a
  // restart. Boot-time `handle.config` would freeze the list to whatever was
  // declared at startup.
  getConfig: () => handle.configStore.getSnapshot().config,
});

const handlePluginsRoute = createPluginsRoute({
  pluginRegistry: handle.pluginRegistry,
  getConfig: () => handle.configStore.getSnapshot().config,
});

const handleImSettings = createImSettingsRoutes({
  modules: imResult.modules,
  bundles: imResult.bundles,
  // Pull config per-request so a /settings/env commit's language change is
  // visible to the very next IM action dispatch — see ImSettingsRoutesDeps.
  getConfig: () => handle.configStore.getSnapshot().config,
  logger: handle.logger,
});

const handleContributions = createContributionsRoutes({
  pluginRegistry: handle.pluginRegistry,
  getConfig: () => handle.configStore.getSnapshot().config,
  getAssetDir: (pluginId) =>
    handle.pluginRegistry.getSettingsContribution(pluginId)?.assetDir ??
    imResult.bundles.find((b) => b.channelId === pluginId)?.staticDir,
  readBody,
  logger: handle.logger,
});

// Plugin postInit hooks fire AFTER composition-layer services (im_runtime) are attached
// to the registry, so a digest/reply plugin's postInit can look up `im_runtime` and wire
// outbound delivery. Only the long-running server needs this; CLI submit exits after one
// pipeline run and never engages postInit consumers.
await handle.runPluginPostInit();

setTrustProxy(handle.config.trustProxy);
if (handle.config.trustProxy) {
  handle.logger.warn(
    'GOLDPAN_TRUST_PROXY is enabled — ensure only a trusted reverse proxy can reach this server, ' +
      'and that it strips/overwrites the X-Forwarded-For header.',
  );
}

const CORS_ORIGINS = parseCorsOrigins(process.env.GOLDPAN_CORS_ORIGINS);
const DEBUG_API = (() => {
  const v = process.env.GOLDPAN_DEBUG_API;
  if (v === undefined || v === '') return process.env.NODE_ENV !== 'production';
  return v === 'true' || v === '1';
})();

// Track in-flight HTTP handler promises for graceful shutdown
const inflightRequests = new Set<Promise<void>>();

const server = http.createServer((req, res) => {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://localhost:${port}`);
  } catch {
    req.resume();
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', code: 'invalid_url', message: 'Invalid request URL' }));
    return;
  }
  const p = handleRequest(req, res, url);
  inflightRequests.add(p);
  p.catch((err) => {
    handle.logger.error('Request handler error', {
      err: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', code: 'internal', message: 'Internal error' }));
    }
  }).finally(() => inflightRequests.delete(p));
});

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Reject requests arriving on keep-alive connections after shutdown started
  if (shuttingDown) {
    req.resume();
    res.writeHead(503);
    res.end(
      JSON.stringify({ type: 'error', code: 'shutting_down', message: 'Server shutting down' }),
    );
    return;
  }

  // CORS
  if (handleCors(req, res, CORS_ORIGINS)) return;

  // Health check is exempted from rate-limiting so container probes do not
  // deplete the per-IP quota, and so a flooded IP can still be observed as
  // alive by its orchestrator.
  const isHealthCheck =
    (req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health';

  // Pre-verify auth once per request so authenticated traffic bypasses the
  // rate limiter and downstream gates can reuse the result without re-running
  // the HMAC compare. When `authPassword` is unset (auth disabled) we treat
  // all callers as pre-authenticated — the operator has explicitly opted out
  // of auth, and the IP-keyed cap was punishing legitimate self-host traffic
  // because all web→server hops share a single loopback IP.
  const authPassword = handle.config.authPassword;
  const isPreAuthenticated = !authPassword || verifyAuth(req, authPassword);

  // Sliding-window rate limit on unauthenticated traffic only. Failed/missing
  // auth still counts toward the IP bucket — that preserves the brute-force
  // protection on /auth/login and on Bearer-token guessing across any method
  // (GET/POST/PUT/DELETE). HEAD/OPTIONS/health remain unconditionally exempt
  // because they're CORS preflight or infrastructure probes.
  if (!isHealthCheck && req.method !== 'OPTIONS' && req.method !== 'HEAD' && !isPreAuthenticated) {
    if (!checkRateLimit(getRateLimitKey(req))) {
      req.resume();
      res.writeHead(429);
      res.end(
        JSON.stringify({ type: 'error', code: 'rate_limited', message: 'Too many requests' }),
      );
      return;
    }
  }

  // Auth check for POST endpoints: if GOLDPAN_AUTH_PASSWORD is set, require Bearer token.
  // Global POST auth gate — excludes /auth/* (login) and /digest/share/* (HMAC-gated,
  // auth-bypassed). The share route will always reject non-GET with 405 before HMAC verify.
  if (
    req.method === 'POST' &&
    authPassword &&
    !url.pathname.startsWith('/auth/') &&
    !url.pathname.startsWith('/digest/share/')
  ) {
    if (!isPreAuthenticated) {
      req.resume();
      res.writeHead(401);
      res.end(JSON.stringify({ type: 'error', code: 'unauthorized', message: 'Unauthorized' }));
      return;
    }
  }

  if (isHealthCheck) {
    req.resume();
    try {
      handle.repos.task.getRecent(1);
      const workerRunning = !!globalThis.__goldpan_worker_started;
      const { statusCode, body } = buildHealthResponse({
        workerRunning,
        runtimeChannels: imRuntime?.describeChannels() ?? [],
        pendingRestartKeys: pendingRestartKeysSet,
        dualProcessConfigHash: dualProcessConfigHash(),
      });
      res.writeHead(statusCode);
      res.end(JSON.stringify(body));
    } catch {
      res.writeHead(503);
      res.end(
        JSON.stringify({
          type: 'error',
          code: 'db_unavailable',
          message: 'Database is unavailable',
          status: 'error',
        }),
      );
    }
    return;
  }

  // Web (separate Next.js process, no DB connection of its own) reads this to
  // recover effective UI locale + timezone after a wizard restart —
  // i18n/request.ts (language) and lib/tz-fetch.ts (timezone, Task 10) both
  // call /api/runtime-info/effective-env which the web middleware rewrites
  // here. GOLDPAN_AUTH_PASSWORD is also dual-process but is never returned
  // from a public endpoint. Authentication is intentionally skipped so the
  // login page can render with the user's locale + timezone before the
  // password gate; rate-limit exemption matches /health for the same
  // "infrastructure probe" reason (web hits this on every cold boot of its
  // Node process, and a flooded IP shouldn't make every page render in the
  // fallback locale / UTC).
  if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    url.pathname === '/runtime-info/effective-env'
  ) {
    req.resume();
    const snap = handle.configStore.getSnapshot();
    const language = snap.config.language;
    const timezone = snap.config.timezone;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ language, timezone }));
    return;
  }

  // Supervisor probe — settings page renders the same one-click-restart panel
  // as `/onboarding/complete`, which needs the supervisor hint to choose
  // between auto-restart and manual-instruction flows. Public on purpose:
  // the value is non-sensitive (`docker` / `supervised` / `concurrently` /
  // `unknown`) and the wizard exposes the same probe at
  // `/onboarding/runtime-info`. Skipping auth + rate-limit matches the
  // /health and /runtime-info/effective-env precedent for "infrastructure
  // probes used during page boot."
  if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    url.pathname === '/runtime-info/supervisor'
  ) {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ supervisor: detectSupervisor() }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/submit') {
    const body = await readBody(req, res);
    if (body === null) return;

    const parsed = parseJsonBody<{ input?: unknown }>(res, body);
    if (parsed === null) return;
    if (typeof parsed.input !== 'string' || !parsed.input.trim()) {
      respondError(res, 400, 'invalid_input', 'Missing "input" field');
      return;
    }
    const input = parsed.input;

    try {
      const result = await submitInput(input, {
        db: handle.db,
        submissionLog: handle.repos.submissionLog,
        // hot-read: maxTextInputLength is a no-restart setting, so read the live
        // snapshot (ssrf stays on frozen handle.config — restart-required).
        maxTextInputLength: handle.configStore.getSnapshot().config.maxTextInputLength,
        ssrfValidationEnabled: handle.config.ssrfValidationEnabled,
      });
      const statusCode = submitStatusToHttp(result.status);
      // Strip internal DB IDs (sourceId, existingSourceId) from response
      const responseBody: Record<string, unknown> = { status: result.status };
      if (result.status === 'accepted') {
        responseBody.taskId = result.taskId;
        responseBody.warnings = result.warnings;
      } else if (result.status === 'duplicate') {
        responseBody.message = 'Duplicate URL';
        responseBody.existingSourceId = result.existingSourceId;
        responseBody.existingTaskId = result.existingTaskId;
        responseBody.existingUrl = result.existingUrl;
      } else if (result.status === 'rejected') {
        responseBody.code = result.code;
        responseBody.reason = result.reason;
      }
      res.writeHead(statusCode);
      res.end(JSON.stringify(responseBody));
    } catch (err) {
      handle.logger.error('Submit failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      res.writeHead(500);
      res.end(JSON.stringify({ type: 'error', code: 'internal', message: 'Internal error' }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/input') {
    const body = await readBody(req, res);
    if (body === null) return;

    const parsed = parseJsonBody<{
      input?: unknown;
      sessionKey?: unknown;
      conversationId?: unknown;
      forcedIntent?: unknown;
      payload?: unknown;
    }>(res, body);
    if (parsed === null) return;
    if (typeof parsed.input !== 'string' || !parsed.input.trim()) {
      respondError(res, 400, 'invalid_input', 'Missing "input" field');
      return;
    }
    const input = parsed.input;
    // hot-read: maxTextInputLength is a no-restart setting (live snapshot).
    if (input.trim().length > handle.configStore.getSnapshot().config.maxTextInputLength) {
      respondError(res, 400, 'text_too_long', 'Input too long');
      return;
    }

    // P4: clarify chip click 走 forcedIntent + payload 跳过 classifier。两者
    // 在 API surface 必须成对出现 —— payload 单独存在没有目的地（free-text
    // 路径 plugin 拿不到 chip 的 intent context），但 forcedIntent 可以单独
    // 出现（IM bound-intent 命令路径就只用 forcedIntent）。
    let forcedIntent: string | undefined;
    if (parsed.forcedIntent !== undefined) {
      if (typeof parsed.forcedIntent !== 'string' || !parsed.forcedIntent.trim()) {
        respondError(res, 400, 'invalid_forced_intent', 'forcedIntent must be non-empty string');
        return;
      }
      forcedIntent = parsed.forcedIntent;
    }
    let payload: string | undefined;
    if (parsed.payload !== undefined) {
      if (typeof parsed.payload !== 'string') {
        respondError(res, 400, 'invalid_payload', 'payload must be string');
        return;
      }
      payload = parsed.payload;
    }

    const sessionKey = typeof parsed.sessionKey === 'string' ? parsed.sessionKey : null;
    if (sessionKey !== null && sessionKey !== WEB_SESSION_KEY) {
      respondError(res, 400, 'invalid_session_key', `sessionKey must be "${WEB_SESSION_KEY}"`);
      return;
    }
    const hasConversationId = parsed.conversationId !== undefined && parsed.conversationId !== null;
    const conversationIdInput =
      typeof parsed.conversationId === 'number' &&
      Number.isInteger(parsed.conversationId) &&
      parsed.conversationId > 0
        ? parsed.conversationId
        : null;
    if (hasConversationId && conversationIdInput === null) {
      respondError(
        res,
        400,
        'invalid_conversation_id',
        'conversationId must be a positive integer',
      );
      return;
    }

    let conversationCtx: ConversationContext | undefined;
    let effectiveConversationId: number | null = null;
    let conv: {
      id: number;
      sessionKey: string;
      channelId: string;
      archivedAt: number | null;
    } | null = null;

    if (sessionKey || conversationIdInput) {
      const convRepo = handle.repos.conversation;

      if (conversationIdInput) {
        conv = convRepo.loadConversationById(conversationIdInput);
        if (!conv) {
          respondError(res, 404, 'conversation_not_found', 'conversation not found');
          return;
        }
        if (conv.sessionKey !== WEB_SESSION_KEY) {
          respondError(
            res,
            403,
            'forbidden_cross_channel',
            'cannot use conversation outside the default web session',
          );
          return;
        }
        if (conv.archivedAt !== null) {
          respondError(
            res,
            409,
            'conversation_archived',
            'conversation is archived, unarchive first',
          );
          return;
        }
        effectiveConversationId = conv.id;
      } else if (sessionKey) {
        const { id } = convRepo.findOrCreate(sessionKey, WEB_CHANNEL_ID);
        conv = convRepo.loadConversationById(id);
        effectiveConversationId = id;
      }
    }

    // P3 Path A: 在 appendMessage 之前合并 active buffered（同 sessionKey 有
    // 未过期 buffer 时）。effectiveInput 既落 conversation_messages，也传给
    // handleInput → classifier 用合并后的完整语义重新判断 intent。
    let effectiveInput = input;
    const mergeSessionKey = sessionKey ?? conv?.sessionKey;
    if (mergeSessionKey) {
      // P3 Path C (A5 修复)：在 Path A merge 之前 await 处理 expired buffered。
      // 把原 input.ts 内的 fire-and-forget IIFE 提到 caller 入口，保证 fallback
      // assistant turn 一定在新 user turn 之前入库，UI 时间序正确。
      await reconcileExpiredBufferedBySession(mergeSessionKey, {
        db: handle.db,
        repos: {
          llmCall: handle.repos.llmCall,
          submissionLog: handle.repos.submissionLog,
          knowledge: handle.repos.knowledge,
          category: handle.repos.category,
          notes: handle.repos.notes,
          source: handle.repos.source,
          conversation: handle.repos.conversation,
        },
        logger: handle.logger,
        handleInput,
        callLlm: handle.callLlm,
        pluginRegistry: handle.pluginRegistry,
        // maxTextInputLength is hot (no-restart); refresh only that field from the
        // live snapshot. Keep the rest of the frozen boot config — ssrf etc. are
        // restart-required and must not go live via a whole-config swap.
        config: {
          ...handle.config,
          maxTextInputLength: handle.configStore.getSnapshot().config.maxTextInputLength,
        },
        embeddingProvider: handle.embeddingProvider,
      });
      const merged = findAndMergeBuffered(mergeSessionKey, input, {
        repo: handle.repos.conversation,
      });
      effectiveInput = merged.input;
      if (merged.merged) {
        handle.logger.debug('/input: merged buffered message', {
          sessionKey: mergeSessionKey,
          previousMessageId: merged.previousMessageId,
        });
      }
    }

    if (conv) {
      conversationCtx =
        handle.repos.conversation.loadContext(
          conv.sessionKey,
          handle.config.im.conversationWindowSize,
        ) ?? undefined;
    }

    // P2: capture user message id so handleInput can pin note.sourceMessageId /
    // markBufferedWait CAS target onto the exact turn we just persisted.
    let appendedUserMsgId: number | undefined;
    if (conversationCtx && effectiveConversationId !== null) {
      const { id } = handle.repos.conversation.appendMessage(effectiveConversationId, {
        role: 'user',
        content: effectiveInput,
      });
      appendedUserMsgId = id;
    }

    const controller = new AbortController();
    try {
      const socketTimeout = handle.config.serverSocketTimeoutMs;
      const inputTimeoutMs =
        socketTimeout > 0
          ? Math.min(DEFAULT_INPUT_TIMEOUT_MS, socketTimeout - 5_000)
          : DEFAULT_INPUT_TIMEOUT_MS;
      const requestTimeout = setTimeout(() => controller.abort(), Math.max(inputTimeoutMs, 10_000));
      let result: Awaited<ReturnType<typeof handleInput>>;
      try {
        result = await handleInput(effectiveInput, {
          db: handle.db,
          callLlm: handle.callLlm,
          pluginRegistry: handle.pluginRegistry,
          // maxTextInputLength is hot (no-restart) — refresh only it; ssrf etc. stay
          // on the frozen boot config (restart-required).
          config: {
            ...handle.config,
            maxTextInputLength: handle.configStore.getSnapshot().config.maxTextInputLength,
          },
          repos: {
            llmCall: handle.repos.llmCall,
            submissionLog: handle.repos.submissionLog,
            knowledge: handle.repos.knowledge,
            category: handle.repos.category,
            // P2: intent-note 写 notes 表 + 反查 detail
            notes: handle.repos.notes,
            // P2: intent-tracking / intent-note 反查 source.entity_ids
            source: handle.repos.source,
            // P2: handleInput wait 分支 markBufferedWait + 反查 message
            conversation: handle.repos.conversation,
          },
          logger: handle.logger,
          signal: controller.signal,
          embeddingProvider: handle.embeddingProvider,
          conversation: conversationCtx,
          // P2: 让 intent-note 把 note.sourceMessageId 关联到刚写的 user turn；
          // wait 分支用作 markBufferedWait 的 CAS 目标。undefined 时 wait 决策
          // 降级为立即跑 fallbackIntent（详见 input.ts 注释）。
          currentUserMessageId: appendedUserMsgId,
          // P4: chip click 路径透传到 input.ts execute 分支 → IntentExecutionContext。
          ...(forcedIntent !== undefined && { forcedIntent }),
          ...(payload !== undefined && { payload }),
        });
      } finally {
        clearTimeout(requestTimeout);
      }

      const { statusCode, responseBody } = serializeHandleInputResult(result);

      if (effectiveConversationId !== null) {
        // Always pair the pre-appended user message with an assistant message
        // so loadContext never hands a dangling user turn to the next LLM call.
        // P2: wait 是例外 —— buffer 释放路径在合并后由 P3 finalize 才写 assistant
        // turn；这里写会污染 conversation。
        if (result.type === 'error') {
          handle.repos.conversation.appendMessage(effectiveConversationId, {
            role: 'assistant',
            content: '[processing failed]',
            metadata: { resultType: 'error', errorCode: result.code },
          });
        } else if (result.type === 'submit') {
          const sr = result.result;
          handle.repos.conversation.appendMessage(effectiveConversationId, {
            role: 'assistant',
            content: `[submit:${sr.status}]`,
            metadata: {
              resultType: 'submit',
              submitStatus: sr.status,
              ...(sr.status === 'accepted' && {
                taskId: sr.taskId,
                sourceId: sr.sourceId,
                // Persist inputMode so reloads can pick the correct bubble
                // (TaskBubbleCard vs NoteBubbleCard) without re-running intent
                // classification or fetching the task to inspect input_type.
                ...(sr.inputMode !== undefined && { inputMode: sr.inputMode }),
              }),
              ...(sr.status === 'duplicate' && {
                existingSourceId: sr.existingSourceId,
                existingTaskId: sr.existingTaskId,
                existingUrl: sr.existingUrl,
              }),
              ...(sr.status === 'rejected' && { rejectCode: sr.code, rejectReason: sr.reason }),
            },
          });
        } else if (result.type === 'query') {
          // Persist hydrated citations alongside the answer so the web UI can
          // re-render the rich card (chips + confidence) on reload — without
          // them, the bubble degrades to plain text after a refresh.
          handle.repos.conversation.appendMessage(effectiveConversationId, {
            role: 'assistant',
            content: result.result.answer,
            metadata: {
              resultType: 'query',
              confidence: result.result.confidence,
              citedEntities: result.citedEntities ?? [],
              citedPoints: result.citedPoints ?? [],
            },
          });
        } else if (result.type === 'note') {
          // P2: i18n 走 core 的 t()（packages/core/src/i18n），与 IM dispatcher
          // 用同一份 messages，确保 web + IM 看到一致的确认文案。
          handle.repos.conversation.appendMessage(effectiveConversationId, {
            role: 'assistant',
            content: t('intent_note.saved_assistant_text', { noteId: result.detail.id }),
            metadata: {
              resultType: 'note',
              noteId: result.detail.id,
              subtype: result.detail.subtype,
            },
          });
        } else if (result.type === 'tracking_pending') {
          const key =
            result.reasonKey === 'waiting_pipeline'
              ? 'intent_tracking.pending_pipeline_assistant_text'
              : 'intent_tracking.pending_multi_entity_assistant_text';
          handle.repos.conversation.appendMessage(effectiveConversationId, {
            role: 'assistant',
            content: t(key),
            metadata: {
              resultType: 'tracking_pending',
              trackingRuleId: result.trackingRuleId,
              reasonKey: result.reasonKey,
            },
          });
        } else if (result.type === 'wait') {
          // P2: wait 决策已经把 user turn 标记为 buffered_wait（input.ts 里）。
          // 这里特意不写 assistant turn —— P3 buffer 释放后才补写。
          // 与 IM dispatcher 行为保持一致（dispatcher.ts 同样跳过 wait）。
        } else {
          // Remaining types: 'content' | 'action' | 'clarify'. The 'error' /
          // 'submit' / 'query' / 'note' / 'tracking_pending' branches above
          // persist their own bespoke metadata. Use the shared assistant-turn
          // reducer here so clarify keyed fields survive reloads.
          const turn = extractAssistantTurn(result);
          if (turn !== null) {
            handle.repos.conversation.appendMessage(effectiveConversationId, {
              role: 'assistant',
              content: turn.content,
              metadata: turn.metadata,
            });
          }
        }
        responseBody.conversationId = effectiveConversationId;
      }
      res.writeHead(statusCode);
      res.end(JSON.stringify(responseBody));
    } catch (err) {
      const errorCode = controller.signal.aborted ? 'timeout' : 'internal';
      // Pair the pre-appended user message with an error stub so the next
      // loadContext doesn't see a dangling user turn.
      if (effectiveConversationId !== null) {
        try {
          handle.repos.conversation.appendMessage(effectiveConversationId, {
            role: 'assistant',
            content: '[processing failed]',
            metadata: { resultType: 'error', errorCode },
          });
        } catch (appendErr) {
          handle.logger.warn('Failed to append error stub', {
            err: appendErr instanceof Error ? appendErr.message : String(appendErr),
          });
        }
      }
      if (controller.signal.aborted) {
        handle.logger.warn('Input handling timed out', {
          err: err instanceof Error ? err.message : String(err),
        });
        res.writeHead(504);
        res.end(JSON.stringify({ type: 'error', code: 'timeout', message: 'Request timed out' }));
      } else {
        handle.logger.error('Input handling failed', {
          err: err instanceof Error ? err.message : String(err),
        });
        res.writeHead(500);
        res.end(JSON.stringify({ type: 'error', code: 'internal', message: 'Internal error' }));
      }
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/query') {
    const body = await readBody(req, res);
    if (body === null) return;

    const parsed = parseJsonBody<{ query?: unknown }>(res, body);
    if (parsed === null) return;
    if (typeof parsed.query !== 'string') {
      respondError(res, 400, 'missing_query', 'Missing "query" field');
      return;
    }
    const query = parsed.query.trim();
    if (!query) {
      respondError(res, 400, 'missing_query', 'Query is empty');
      return;
    }
    if (query.length > MAX_QUERY_LENGTH) {
      respondError(
        res,
        400,
        'query_too_long',
        `Query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`,
      );
      return;
    }

    const controller = new AbortController();
    try {
      const socketTimeout = handle.config.serverSocketTimeoutMs;
      const queryTimeoutMs =
        socketTimeout > 0
          ? Math.min(DEFAULT_QUERY_TIMEOUT_MS, socketTimeout - 5_000)
          : DEFAULT_QUERY_TIMEOUT_MS;
      const requestTimeout = setTimeout(() => controller.abort(), Math.max(queryTimeoutMs, 10_000));
      let result: Awaited<ReturnType<typeof queryKnowledge>>;
      try {
        result = await queryKnowledge(query, {
          db: handle.db,
          callLlm: handle.callLlm,
          llmCallRepo: handle.repos.llmCall,
          language: handle.config.language,
          logPayloads: handle.config.llmLogPayloads,
          llmTimeout: handle.config.llmTimeout,
          signal: controller.signal,
          embeddingProvider: handle.embeddingProvider,
          logger: handle.logger,
        });
      } finally {
        clearTimeout(requestTimeout);
      }
      res.writeHead(200);
      res.end(
        JSON.stringify({
          type: 'query',
          answer: result.answer,
          confidence: result.confidence,
          citedEntityIds: result.citedEntityIds,
          citedPointIds: result.citedPointIds,
        }),
      );
    } catch (err) {
      if (controller.signal.aborted) {
        handle.logger.warn('Query timed out', {
          err: err instanceof Error ? err.message : String(err),
        });
        res.writeHead(504);
        res.end(JSON.stringify({ type: 'error', code: 'timeout', message: 'Request timed out' }));
      } else {
        handle.logger.error('Query failed', {
          err: err instanceof Error ? err.message : String(err),
        });
        res.writeHead(500);
        res.end(JSON.stringify({ type: 'error', code: 'internal', message: 'Internal error' }));
      }
    }
    return;
  }

  // --- Helper: build RouteContext for route handlers ---
  const buildCtx = (segments: string[]) => ({
    req,
    res,
    url,
    segments,
    handle,
    readBody: () => readBody(req, res),
    getClientIp: () => getRateLimitKey(req),
    debugApiEnabled: DEBUG_API,
  });

  // --- Helper: check auth, send 401 if failed. Returns true if auth is OK. ---
  // Reuses the request-scoped pre-auth result so the HMAC compare runs once.
  const authRequired = (): boolean => {
    if (!authPassword) return true;
    if (isPreAuthenticated) return true;
    req.resume();
    respondError(res, 401, 'unauthorized', 'Unauthorized');
    return false;
  };

  // --- Auth routes ---
  if (url.pathname.startsWith('/auth/')) {
    const segments = url.pathname.slice('/auth/'.length).split('/').filter(Boolean);
    await handleAuthRoutes(buildCtx(segments));
    return;
  }

  // --- Task routes (auth required; rate-limit is enforced globally above) ---
  if (url.pathname === '/tasks' || url.pathname.startsWith('/tasks/')) {
    if (!authRequired()) return;
    const segments = url.pathname.slice('/tasks/'.length).split('/').filter(Boolean);
    await handleTaskRoutes(buildCtx(segments));
    return;
  }

  // --- Source routes (auth required; rate-limit is enforced globally above) ---
  if (url.pathname === '/sources' || url.pathname.startsWith('/sources/')) {
    if (!authRequired()) return;
    const segments = url.pathname.slice('/sources/'.length).split('/').filter(Boolean);
    await handleSourceRoutes(buildCtx(segments));
    return;
  }

  // --- Knowledge routes (auth required) ---
  if (url.pathname === '/categories' || url.pathname.startsWith('/categories/')) {
    if (!authRequired()) return;
    const segments = url.pathname.slice('/categories/'.length).split('/').filter(Boolean);
    await handleKnowledgeRoutes(buildCtx(segments), 'categories');
    return;
  }

  if (url.pathname === '/entities' || url.pathname.startsWith('/entities/')) {
    if (!authRequired()) return;
    const segments = url.pathname.slice('/entities/'.length).split('/').filter(Boolean);
    await handleKnowledgeRoutes(buildCtx(segments), 'entities');
    return;
  }

  // --- Note routes (auth required) ---
  if (url.pathname === '/notes' || url.pathname.startsWith('/notes/')) {
    if (!authRequired()) return;
    const segments = url.pathname.slice('/notes/'.length).split('/').filter(Boolean);
    await handleNoteRoutes(buildCtx(segments));
    return;
  }

  // --- User Notes routes (P1 user-authored notes, distinct from the /notes
  // source-view compatibility URL). Auth required, same context.
  if (url.pathname === '/user-notes' || url.pathname.startsWith('/user-notes/')) {
    if (!authRequired()) return;
    const segments = url.pathname
      .slice('/user-notes'.length)
      .replace(/^\//, '')
      .split('/')
      .filter(Boolean);
    await handleUserNoteRoutes(buildCtx(segments));
    return;
  }

  // --- Digest share routes (auth-bypassed, HMAC-gated) ---
  // 必须在 /digest catch-all 之前,绕开 authRequired();405 + cache headers
  // 都在 handleDigestRoutes 的 share branch 里,避免两处 drift。
  // 注意 slice 用 `/digest/`（保留 'share' 段给 handler）。
  if (url.pathname.startsWith('/digest/share/')) {
    const segments = url.pathname.slice('/digest/'.length).split('/').filter(Boolean);
    await handleDigestRoutes(buildCtx(segments));
    return;
  }

  // --- Digest routes (auth required) ---
  if (url.pathname === '/digest' || url.pathname.startsWith('/digest/')) {
    if (!authRequired()) return;
    const segments = url.pathname.slice('/digest/'.length).split('/').filter(Boolean);
    await handleDigestRoutes(buildCtx(segments));
    return;
  }

  // --- Debug routes (auth required) ---
  if (url.pathname.startsWith('/debug/')) {
    if (!authRequired()) return;
    const segments = url.pathname.slice('/debug/'.length).split('/').filter(Boolean);
    await handleDebugRoutes(buildCtx(segments));
    return;
  }

  // --- Tracking routes (auth required) ---
  if (url.pathname === '/tracking' || url.pathname.startsWith('/tracking/')) {
    if (!authRequired()) return;
    const segments = url.pathname.slice('/tracking'.length).split('/').filter(Boolean);
    await handleTrackingRoutes(buildCtx(segments));
    return;
  }

  // --- Settings routes (auth required) ---
  // POST /settings/env writes to `.env` (shared with onboarding wizard);
  // GET /settings/env-state returns masked live values for the UI.
  if (url.pathname === '/settings' || url.pathname.startsWith('/settings/')) {
    if (!authRequired()) return;
    if (url.pathname === '/settings/llm-providers') {
      await handleLlmProvidersRoute(buildCtx([]));
      return;
    }
    if (url.pathname === '/settings/plugins') {
      await handlePluginsRoute(buildCtx([]));
      return;
    }
    if (url.pathname.startsWith('/settings/im/')) {
      await handleImSettings(req, res, url.pathname);
      return;
    }
    if (
      url.pathname === '/settings/contributions' ||
      url.pathname.startsWith('/settings/contributions/')
    ) {
      await handleContributions(req, res, url);
      return;
    }
    const segments = url.pathname.slice('/settings/'.length).split('/').filter(Boolean);
    await handleSettingsRoutes(buildCtx(segments));
    return;
  }

  // --- Server admin routes (auth required) ---
  // Wizard mode mounts the same factory in wizard-server.ts (no auth check
  // inside the factory — wizard relies on localhost-only binding, normal mode
  // relies on the `authRequired()` gate immediately below).
  if (url.pathname === '/server/restart' && req.method === 'POST') {
    if (!authRequired()) return;
    const handler = createRestartHandler({
      logger: handle.logger,
      onRestart: () => shutdown('restart'),
    });
    handler(req, res);
    return;
  }

  // --- Conversations routes ---
  // GET / DELETE: explicit `authRequired()` guard (aligns with tasks/sources/etc).
  // POST: implicit via global main.ts POST auth above.
  // Cross-channel guard: channelId or sessionKey must be 'web' / 'web:…' — non-web returns 403.

  // P3 Buffer Path B — POST /conversations/buffered/:id/{release,cancel}.
  // Placed before the generic /conversations/:id routes so the literal
  // /buffered/ segment can't be mis-parsed as a conversation id. Both POSTs
  // are gated by the global POST auth check above (line ~548).
  if (
    req.method === 'POST' &&
    /^\/conversations\/buffered\/\d+\/(release|cancel)$/.test(url.pathname)
  ) {
    const match = url.pathname.match(/^\/conversations\/buffered\/(\d+)\/(release|cancel)$/);
    if (!match) {
      respondError(res, 400, 'bad_request', 'Invalid buffered route');
      return;
    }
    const messageId = Number(match[1]);
    const action = match[2] as 'release' | 'cancel';
    const ctx = buildCtx([]);
    if (action === 'release') {
      await handleBufferedRelease(ctx, messageId);
    } else {
      await handleBufferedCancel(ctx, messageId);
    }
    return;
  }

  if (url.pathname === '/conversations/active' && req.method === 'GET') {
    if (!authRequired()) return;
    const channelId = url.searchParams.get('channelId');
    if (channelId !== WEB_CHANNEL_ID) {
      respondError(
        res,
        channelId ? 403 : 400,
        channelId ? 'forbidden_cross_channel' : 'invalid_query',
        channelId ? 'only channelId=web is allowed from web' : 'channelId required',
      );
      return;
    }
    // P3 Path D reconcile: user is reopening the chat surface. Fire-and-forget
    // (取舍 13) — this GET still returns immediately with current state; the
    // finalize result (assistant turn) lands by the next poll / GET. Path D
    // is defensive bottom: client-side release timer (Task 11) is the primary
    // trigger; this catches the case where that timer didn't fire (tab closed
    // before expiry, cross-device, etc).
    scheduleReconcileForSession(WEB_SESSION_KEY, handle);
    const id = handle.repos.conversation.findActiveBySessionKey(WEB_SESSION_KEY);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id }));
    return;
  }

  if (url.pathname === '/conversations' && req.method === 'GET') {
    if (!authRequired()) return;
    const channelId = url.searchParams.get('channelId') ?? WEB_CHANNEL_ID;
    if (channelId !== WEB_CHANNEL_ID) {
      respondError(res, 403, 'forbidden_cross_channel', 'only channelId=web is allowed from web');
      return;
    }
    const rawLimit = url.searchParams.get('limit');
    const parsedLimit = rawLimit === null ? 20 : parsePositiveIntParam(rawLimit);
    if (parsedLimit === null) {
      respondError(res, 400, 'invalid_limit', 'limit must be a positive integer');
      return;
    }
    const rawOffset = url.searchParams.get('offset');
    const parsedOffset = rawOffset === null ? 0 : Number(rawOffset);
    if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
      respondError(res, 400, 'invalid_offset', 'offset must be a non-negative integer');
      return;
    }
    const limit = Math.min(100, parsedLimit);
    const offset = parsedOffset;
    const includeActive = url.searchParams.get('includeActive') === 'true';
    const { items, total } = handle.repos.conversation.listBySessionKey({
      sessionKey: WEB_SESSION_KEY,
      limit,
      offset,
      includeActive,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        items: items.map((x: ConversationListItem) => ({
          id: x.id,
          sessionKey: x.sessionKey,
          channelId: x.channelId,
          title: x.title,
          createdAt: x.createdAt,
          updatedAt: x.updatedAt,
          lastMessageAt: x.lastMessageAt,
          archivedAt: x.archivedAt,
          archivedReason: x.archivedReason,
          messageCount: x.messageCount,
        })),
        total,
      }),
    );
    return;
  }

  if (req.method === 'POST' && url.pathname === '/conversations/new') {
    const body = await readBody(req, res);
    if (body === null) return;
    const parsed = parseJsonBody<{ channelId?: unknown; sessionKey?: unknown }>(res, body);
    if (parsed === null) return;
    const channelId = typeof parsed.channelId === 'string' ? parsed.channelId : WEB_CHANNEL_ID;
    if (channelId !== WEB_CHANNEL_ID) {
      respondError(res, 403, 'forbidden_cross_channel', 'only channelId=web is allowed from web');
      return;
    }
    const sessionKey = typeof parsed.sessionKey === 'string' ? parsed.sessionKey : WEB_SESSION_KEY;
    if (sessionKey !== WEB_SESSION_KEY) {
      respondError(res, 400, 'invalid_session_key', `sessionKey must be "${WEB_SESSION_KEY}"`);
      return;
    }
    handle.repos.conversation.archive(sessionKey, 'user_reset');
    const { id } = handle.repos.conversation.findOrCreate(sessionKey, channelId);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id }));
    return;
  }

  if (
    req.method === 'POST' &&
    url.pathname.startsWith('/conversations/') &&
    url.pathname.endsWith('/unarchive')
  ) {
    const idStr = url.pathname.slice('/conversations/'.length, -'/unarchive'.length);
    const id = Number(idStr);
    if (!Number.isInteger(id) || id <= 0) {
      respondError(res, 400, 'invalid_id', 'invalid conversation id');
      return;
    }
    const existing = handle.repos.conversation.loadConversationById(id);
    if (!existing) {
      respondError(res, 404, 'conversation_not_found', 'conversation not found');
      return;
    }
    if (existing.sessionKey !== WEB_SESSION_KEY) {
      respondError(res, 403, 'forbidden_cross_channel', 'cannot unarchive non-web conversation');
      return;
    }
    try {
      handle.repos.conversation.unarchive(id);
    } catch (err) {
      if (err instanceof ConversationNotFoundError) {
        respondError(res, 404, 'conversation_not_found', 'conversation not found');
        return;
      }
      throw err;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id }));
    return;
  }

  // GET /conversations/:id — comes after literal /conversations/active above.
  if (req.method === 'GET' && url.pathname.startsWith('/conversations/')) {
    if (!authRequired()) return;
    const idStr = url.pathname.slice('/conversations/'.length);
    const id = Number(idStr);
    if (!Number.isInteger(id) || id <= 0) {
      respondError(res, 400, 'invalid_id', 'invalid conversation id');
      return;
    }
    const conv = handle.repos.conversation.loadConversationById(id);
    if (!conv) {
      respondError(res, 404, 'conversation_not_found', 'conversation not found');
      return;
    }
    if (conv.sessionKey !== WEB_SESSION_KEY) {
      respondError(
        res,
        403,
        'forbidden_cross_channel',
        'cannot read conversation outside the default web session',
      );
      return;
    }
    // P3 Path D reconcile (per-conversation): user is opening a specific
    // conversation. Same fire-and-forget rationale as /active above. Scoped
    // to this conversationId so loading a historical conversation doesn't
    // sweep the entire session's expired buffers.
    scheduleReconcileForConversation(id, handle);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: conv.id,
        sessionKey: conv.sessionKey,
        channelId: conv.channelId,
        archivedAt: conv.archivedAt,
        messages: conv.messages.map((m: ConversationMessageRecord) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          metadata: m.metadata ? (stripInternalKeys(m.metadata) ?? null) : null,
          createdAt: m.createdAt,
          // P3: 暴露 status / bufferedExpiresAt 让 web UI 渲染
          // BufferedWaitIndicator / consumed badge。conditional spread
          // 避免 payload 里塞一堆 `"status":"normal"` 噪音。
          ...(m.status !== undefined && m.status !== 'normal' && { status: m.status }),
          ...(m.bufferedExpiresAt !== undefined && { bufferedExpiresAt: m.bufferedExpiresAt }),
        })),
      }),
    );
    return;
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/conversations/')) {
    if (!authRequired()) return;
    const idStr = url.pathname.slice('/conversations/'.length);
    const id = Number(idStr);
    if (!Number.isInteger(id) || id <= 0) {
      respondError(res, 400, 'invalid_id', 'invalid conversation id');
      return;
    }
    const existing = handle.repos.conversation.loadConversationById(id);
    if (existing && existing.sessionKey !== WEB_SESSION_KEY) {
      respondError(
        res,
        403,
        'forbidden_cross_channel',
        'cannot delete conversation outside the default web session',
      );
      return;
    }
    handle.repos.conversation.deleteById(id);
    res.writeHead(204);
    res.end();
    return;
  }

  if (githubService && url.pathname.startsWith('/github/')) {
    if (authPassword && !isPreAuthenticated) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', code: 'unauthorized', message: 'Auth required' }));
      return;
    }

    const segments = url.pathname.replace('/github/', '').split('/').filter(Boolean);

    if (req.method === 'POST' && segments[0] === 'refresh' && segments.length === 1) {
      const body = await readBody(req, res);
      if (body === null) return;

      const payload = parseJsonBody<{ owner?: unknown; repo?: unknown }>(res, body);
      if (payload === null) return;
      const { owner, repo } = payload;
      if (typeof owner !== 'string' || typeof repo !== 'string' || !owner || !repo) {
        respondError(res, 400, 'invalid_input', 'owner & repo required');
        return;
      }
      try {
        const result = await githubService.refreshRepo({ owner, repo });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        handle.logger.error('POST /github/refresh failed', {
          err: err instanceof Error ? err.message : String(err),
        });
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', code: 'internal', message: 'Internal error' }));
      }
      return;
    }

    if (req.method === 'POST' && segments[0] === 'refresh-by-url' && segments.length === 1) {
      const body = await readBody(req, res);
      if (body === null) return;

      const payload = parseJsonBody<{ normalizedUrl?: unknown }>(res, body);
      if (payload === null) return;
      const { normalizedUrl } = payload;
      if (typeof normalizedUrl !== 'string' || !normalizedUrl) {
        respondError(res, 400, 'invalid_input', 'normalizedUrl required');
        return;
      }
      try {
        const result = await githubService.refreshRepoByNormalizedUrl(normalizedUrl);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        handle.logger.error('POST /github/refresh-by-url failed', {
          err: err instanceof Error ? err.message : String(err),
        });
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', code: 'internal', message: 'Internal error' }));
      }
      return;
    }

    if (req.method === 'GET' && segments[0] === 'state' && segments.length === 1) {
      const owner = url.searchParams.get('owner');
      const repo = url.searchParams.get('repo');
      if (!owner || !repo) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            code: 'invalid_input',
            message: 'owner & repo required',
          }),
        );
        return;
      }
      const state = githubService.getRepoState({ owner, repo });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: state }));
      return;
    }

    req.resume();
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', code: 'not_found', message: 'Unknown github route' }));
    return;
  }

  req.resume();
  res.writeHead(404);
  res.end(JSON.stringify({ type: 'error', code: 'not_found', message: 'Not found' }));
}

server.listen(port, () => {
  handle.logger.info(`goldpan server listening on port ${port}`);
});

// 0 = Node default (no inactivity timeout). Positive values reap idle sockets but
// must exceed worst-case chained LLM time for POST /input and /query.
const configuredSocketTimeout = handle.config.serverSocketTimeoutMs;
server.setTimeout(configuredSocketTimeout);

if (configuredSocketTimeout > 0 && configuredSocketTimeout < MIN_RECOMMENDED_SOCKET_TIMEOUT_MS) {
  handle.logger.warn(
    `GOLDPAN_SERVER_SOCKET_TIMEOUT_MS (${configuredSocketTimeout}ms) is below the recommended ` +
      `minimum of ${MIN_RECOMMENDED_SOCKET_TIMEOUT_MS}ms — POST /input and /query involve ` +
      'chained LLM calls that may exceed this timeout, causing truncated responses.',
  );
}

// Graceful shutdown.
//
// `intent` distinguishes a restart-driven shutdown (the wizard's
// /server/restart route + its normal-mode counterpart) from a regular
// signal-driven shutdown (SIGTERM / SIGINT from a supervisor or Ctrl+C).
// On restart, we additionally SIGTERM the dev-mode tsx watch parent so
// the dev chain's exit code propagates up to the supervisor — see
// lib/restart-cascade.ts. Non-restart shutdowns leave the parent alone:
// the parent already initiated the kill, and re-signalling it would
// either be redundant or actively wrong (e.g., killing a docker init).
let shuttingDown = false;
const shutdown = async (intent?: 'restart') => {
  if (shuttingDown) return;
  shuttingDown = true;
  handle.logger.info('Shutdown signal received');

  // 1. Stop accepting new HTTP connections
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });

  // 2. Stop accepting new IM messages and drain in-flight IM tasks.
  //    MUST happen BEFORE handle.shutdown() because in-flight handleInput
  //    still uses db / callLlm / pluginRegistry from `handle`.
  if (imRuntime) {
    try {
      await imRuntime.shutdown();
    } catch (err) {
      handle.logger.error('IM Runtime shutdown failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Drain in-flight HTTP handlers.
  const SHUTDOWN_DRAIN_TIMEOUT_MS = 60_000;
  const drainResult = await Promise.race([
    Promise.allSettled(inflightRequests).then(() => 'drained' as const),
    new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), SHUTDOWN_DRAIN_TIMEOUT_MS),
    ),
  ]);
  if (drainResult === 'timeout' && inflightRequests.size > 0) {
    handle.logger.warn(
      `Shutdown drain timeout reached with ${inflightRequests.size} request(s) still in flight — proceeding with shutdown`,
    );
  }

  // 4. Core shutdown (worker / tracking scheduler / plugin registry / db).
  try {
    await handle.shutdown();
  } catch (err) {
    handle.logger.error('Shutdown error', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (intent === 'restart') unstickTsxWatchParent();
  process.exit(0);
};
// Wrap so the signal name (Node passes it as the first arg) doesn't
// accidentally land in the `intent` slot.
process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
