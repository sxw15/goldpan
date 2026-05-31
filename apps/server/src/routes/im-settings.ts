// monorepo/apps/server/src/routes/im-settings.ts
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import type { GoldpanConfig } from '@goldpan/core';
import {
  EnvSecretResolver,
  type ImChannelBundle,
  type ImSettingsModule,
} from '@goldpan/im-runtime';
import { loadImChannelConfigs } from '../im/channel-configs.js';
import { respond, respondError } from './types.js';

/**
 * Response-side timeout — guarantees the HTTP response returns within 30s
 * even if a plugin handler hangs. 30s is empirical：feishu / telegram 真实 test
 * 1-3s 内就完成，10x 余量足够；超过即按 timeout 处理。
 *
 * The deadline is enforced via `AbortController` whose signal is exposed to
 * plugin handlers through `ImSettingsActionContext.signal`. Handlers should
 * thread it into outbound `fetch(..., { signal })` so timeout actually cancels
 * the underlying request instead of leaving a zombie promise behind. Plugin
 * handlers that ignore the signal still get the response-side guard (we stop
 * awaiting once aborted), but they remain responsible for releasing their own
 * I/O — the host can only signal, not force-kill.
 *
 * 全 server 的 socket timeout 由 GOLDPAN_SERVER_SOCKET_TIMEOUT_MS 控制；本上限
 * 是更紧的内层 guard。
 */
const HANDLER_TIMEOUT_MS = 30_000;
const HANDLER_TIMEOUT = Symbol('handler_timeout');

export interface ImSettingsRoutesDeps {
  modules: Map<string, ImSettingsModule>;
  bundles: ReadonlyArray<ImChannelBundle>;
  /**
   * Pulls the latest `GoldpanConfig` for each request — wraps
   * `configStore.getSnapshot().config` in normal mode. The action dispatcher
   * needs `language` (forwarded into plugin handler ctx) at request time, not
   * at handler-factory time, so that runtime-config commits via /settings/env
   * take effect on the next action invocation without a server restart.
   *
   * Wizard mode passes a function that throws — wizard UI runs with
   * `disableActions=true` so this branch is unreachable from the supported
   * client; the throw is a fail-safe for direct curl probes against the
   * unauthenticated localhost wizard server.
   */
  getConfig: () => GoldpanConfig;
  logger: {
    warn: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
}

export function createImSettingsRoutes(deps: ImSettingsRoutesDeps) {
  return async function handleImSettings(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<void> {
    // Strip `/settings/im/` prefix.
    const sub = pathname.slice('/settings/im/'.length);
    const segs = sub.split('/').filter(Boolean);

    // GET /settings/im/manifests
    if (req.method === 'GET' && segs[0] === 'manifests' && segs.length === 1) {
      req.resume();
      const manifests = [...deps.modules.values()].map((m) => m.manifest);
      respond(res, 200, { manifests });
      return;
    }

    // POST /settings/im/:channelId/actions/:actionId
    // After slicing the `/settings/im/` prefix, segs[0] is :channelId,
    // segs[1] is the literal `actions`, segs[2] is :actionId.
    if (
      req.method === 'POST' &&
      segs.length === 3 &&
      segs[0] !== undefined &&
      segs[1] === 'actions' &&
      segs[2] !== undefined
    ) {
      const channelId = segs[0];
      const actionId = segs[2];
      req.resume(); // we don't accept body in v1; ignore any payload

      const module = deps.modules.get(channelId);
      if (!module) {
        respondError(res, 404, 'unknown_channel', `Channel ${channelId} not found`);
        return;
      }
      const descriptor = module.manifest.actions.find((a) => a.id === actionId);
      if (!descriptor) {
        respondError(res, 404, 'unknown_action', `Action ${actionId} not found on ${channelId}`);
        return;
      }
      const handler = module.handlers[actionId];
      if (typeof handler !== 'function') {
        respondError(res, 500, 'handler_missing', `No handler implements ${channelId}/${actionId}`);
        return;
      }

      // Fresh config — `configStore.commit()` synchronously applies overrides
      // to `process.env` and bumps the snapshot, so reading `getConfig()` here
      // observes the latest user-saved language without any process restart.
      // Wizard mode passes a throwing closure (actions are disabled by UI);
      // the catch keeps an unauthorised curl probe from crashing the server.
      let freshConfig: GoldpanConfig;
      try {
        freshConfig = deps.getConfig();
      } catch (err) {
        deps.logger.error(`im-settings: getConfig failed for action ${channelId}/${actionId}`, err);
        respond(res, 200, { ok: false, code: 'internal' });
        return;
      }

      // Per-channel slice from the plugin's envSpec.parse(process.env).
      //
      // `process.env` is the fresh truth: `configStore.commit()` writes
      // overrides through to `process.env` synchronously before this handler
      // runs, so a "save credentials → click Test" round-trip sees the just-
      // saved value without needing a separate `.env` re-read step.
      const bundle = deps.bundles.find((b) => b.channelId === channelId);
      if (!bundle) {
        respond(res, 200, { ok: false, code: 'internal' });
        return;
      }
      let values: Record<string, string | boolean | undefined>;
      try {
        const sliceMap = loadImChannelConfigs(process.env, [bundle.envSpec]);
        const slice = sliceMap.get(channelId);
        if (slice === undefined) {
          // Defense in depth: loadImChannelConfigs is supposed to populate the
          // map keyed by channelId, but a future refactor could leave us here.
          deps.logger.error(`im-settings: slice missing for ${channelId} after envSpec.parse`);
          respond(res, 200, { ok: false, code: 'internal' });
          return;
        }
        const resolver = new EnvSecretResolver();
        // Plugin owns the slice→values mapping (T6/T10 toValues). The host
        // never guesses property names — see spec §3.3 envSpec.toValues.
        values = bundle.envSpec.toValues(slice, resolver);
      } catch (err) {
        deps.logger.error(`im-settings: env slice failed for ${channelId}`, err);
        respond(res, 200, { ok: false, code: 'internal' });
        return;
      }

      // Invoke handler with AbortController + redaction guard. The signal is
      // exposed to plugin handlers via `ImSettingsActionContext.signal` so
      // outbound fetch can actually be cancelled when the deadline fires —
      // not just have its result discarded.
      const abortController = new AbortController();
      let timeout!: () => void;
      const timeoutPromise = new Promise<typeof HANDLER_TIMEOUT>((resolve) => {
        timeout = () => {
          abortController.abort();
          resolve(HANDLER_TIMEOUT);
        };
      });
      const timer = setTimeout(timeout, HANDLER_TIMEOUT_MS);
      try {
        const raced = await Promise.race([
          handler({
            values,
            language: freshConfig.language,
            logger: deps.logger as never,
            signal: abortController.signal,
          }),
          timeoutPromise,
        ]);
        if (raced === HANDLER_TIMEOUT) {
          deps.logger.error(`im-settings: handler ${channelId}/${actionId} timed out`, {
            timeoutMs: HANDLER_TIMEOUT_MS,
          });
          respond(res, 200, { ok: false, code: 'timeout' });
          return;
        }
        respond(res, 200, raced);
      } catch (err) {
        if (abortController.signal.aborted) {
          deps.logger.error(`im-settings: handler ${channelId}/${actionId} timed out`, {
            timeoutMs: HANDLER_TIMEOUT_MS,
          });
          respond(res, 200, { ok: false, code: 'timeout' });
          return;
        }
        deps.logger.error(`im-settings: handler ${channelId}/${actionId} threw`, {
          err: err instanceof Error ? err.message : String(err),
        });
        // SECURITY: never echo err.message — may contain secrets.
        respond(res, 200, { ok: false, code: 'internal' });
      } finally {
        clearTimeout(timer);
      }
      return;
    }

    // GET /settings/im/:channelId/assets/<path>
    // After slicing the `/settings/im/` prefix, segs[0] is :channelId,
    // segs[1] is the literal `assets`, segs[2..] is the asset path.
    if (req.method === 'GET' && segs.length >= 2 && segs[1] === 'assets') {
      const channelId = segs[0];
      const requestPath = segs.slice(2).join('/');
      req.resume();

      const bundle = deps.bundles.find((b) => b.channelId === channelId);
      if (!bundle) {
        respondError(res, 404, 'unknown_channel', `Channel ${channelId} not found`);
        return;
      }

      // Path traversal protection: bundle.staticDir is already absolute
      // (loadChannels resolves pluginsDir before joining). resolve() collapses
      // any `..` segments in requestPath; the prefix check then ensures the
      // result stays under staticDir.
      const absolute = path.resolve(bundle.staticDir, requestPath);
      if (!absolute.startsWith(bundle.staticDir + path.sep) && absolute !== bundle.staticDir) {
        respondError(res, 403, 'forbidden', 'Path traversal blocked');
        return;
      }
      try {
        const s = await stat(absolute);
        if (!s.isFile()) {
          respondError(res, 404, 'not_found', 'Asset not found');
          return;
        }
        const ext = path.extname(absolute).toLowerCase();
        const mime: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
          '.webp': 'image/webp',
        };
        res.statusCode = 200;
        res.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream');
        // Plugin assets only change on deploy; 24h cache cuts repeated fetches
        // for the onboarding wizard's setup-guide images.
        res.setHeader('Cache-Control', 'public, max-age=86400');
        const stream = createReadStream(absolute);
        // Without an 'error' listener, an EIO / unlink mid-stream would
        // surface as an unhandled 'error' event and crash the Node process.
        // Status + headers are already flushed at this point, so we can't
        // change the response code — best we can do is destroy the socket.
        stream.on('error', (err) => {
          deps.logger.error(`im-settings: asset stream failed for ${absolute}`, err);
          res.destroy();
        });
        stream.pipe(res);
      } catch {
        // Broad catch is intentional: ENOENT/EACCES/EISDIR/ELOOP collapse to
        // 404 rather than leaking which paths exist-but-are-unreadable.
        respondError(res, 404, 'not_found', 'Asset not found');
      }
      return;
    }

    req.resume();
    respondError(res, 404, 'not_found', 'Unknown im-settings route');
  };
}
