// apps/server/src/routes/contributions.ts
//
// Generic plugin settings contribution routes:
//   GET  /settings/contributions[?locale=zh]
//   POST /settings/contributions/:pluginId/actions/:actionId
//
// Sits orthogonal to the legacy /settings/im/* routes. The latter still
// drives the wizard / IM channel card (returns LocalizedString objects);
// these new routes resolve every LocalizedString server-side and return
// flat strings, ready for generic UI rendering of any plugin (collector /
// intent / tool / llm-provider / IM / future) that registered a
// PluginSettingsContribution at boot.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import type { GoldpanConfig } from '@goldpan/core/config';
import type { SettingsField } from '@goldpan/core/plugins';
import {
  type PluginActionDescriptor,
  type PluginRegistry,
  resolveContribution,
  resolvePluginDescription,
  type SettingsContributionRegistration,
} from '@goldpan/core/plugins';
import { respond, respondError } from './types.js';

const HANDLER_TIMEOUT_MS = 30_000;
const INVALID_FIELD_VALUE = Symbol('invalid_field_value');
const HANDLER_TIMEOUT = Symbol('handler_timeout');

export interface ContributionsRoutesDeps {
  pluginRegistry: PluginRegistry;
  /**
   * Pulled per-request so a /settings/env commit's language change applies on
   * the next call without restarting the server.
   */
  getConfig: () => GoldpanConfig;
  /** Optional asset resolver for setup-guide images. */
  getAssetDir?: (pluginId: string) => string | undefined;
  /**
   * Main server body reader. In production this enforces the shared body size
   * limit and slow-read timeout before action dispatch.
   */
  readBody?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<string | null>;
  logger: {
    debug: (msg: string, ctx?: unknown) => void;
    info: (msg: string, ctx?: unknown) => void;
    warn: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }
  return body;
}

function parseLocale(value: string | null, fallback: 'en' | 'zh'): 'en' | 'zh' {
  if (value === 'en' || value === 'zh') return value;
  return fallback;
}

function coerceFieldValue(
  field: SettingsField,
  raw: unknown,
): string | boolean | number | undefined | typeof INVALID_FIELD_VALUE {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'object' || typeof raw === 'function' || typeof raw === 'symbol') {
    return INVALID_FIELD_VALUE;
  }
  if (field.kind === 'toggle') {
    if (raw === true || raw === false) return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return INVALID_FIELD_VALUE;
  }
  if (field.kind === 'number') {
    if (raw === '') return undefined;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : INVALID_FIELD_VALUE;
  }
  return String(raw);
}

function valuesFromEnv(
  reg: SettingsContributionRegistration,
): Record<string, string | boolean | number | undefined> {
  const values: Record<string, string | boolean | number | undefined> = {};
  for (const field of reg.contribution.fields) {
    const raw = process.env[field.envKey];
    if (raw === undefined) continue;
    const coerced = coerceFieldValue(field, raw);
    if (coerced !== INVALID_FIELD_VALUE) values[field.name] = coerced;
  }
  return values;
}

async function serveAsset(
  deps: ContributionsRoutesDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pluginId: string,
  requestPath: string,
): Promise<void> {
  req.resume();
  const assetDir = deps.getAssetDir?.(pluginId);
  if (assetDir === undefined) {
    respondError(res, 404, 'unknown_plugin_assets', `Assets for plugin "${pluginId}" not found`);
    return;
  }
  const absolute = path.resolve(assetDir, requestPath);
  if (!absolute.startsWith(assetDir + path.sep) && absolute !== assetDir) {
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
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const stream = createReadStream(absolute);
    stream.on('error', (err) => {
      deps.logger.error(`contributions: asset stream failed for ${absolute}`, err);
      res.destroy();
    });
    stream.pipe(res);
  } catch {
    respondError(res, 404, 'not_found', 'Asset not found');
  }
}

export function createContributionsRoutes(deps: ContributionsRoutesDeps) {
  return async function handleContributions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const pathname = url.pathname;
    // GET /settings/contributions
    if (req.method === 'GET' && pathname === '/settings/contributions') {
      req.resume();
      let config: GoldpanConfig;
      try {
        config = deps.getConfig();
      } catch (err) {
        deps.logger.error('contributions: getConfig failed', err);
        respondError(res, 500, 'internal', 'getConfig failed');
        return;
      }
      const locale = parseLocale(url.searchParams.get('locale'), config.language);
      const registrations = deps.pluginRegistry.getSettingsContributions();
      const contributions = registrations.map((r: SettingsContributionRegistration) => {
        const resolved = resolveContribution(r.contribution, locale);
        if (r.pluginVersion !== undefined) {
          resolved.pluginVersion = r.pluginVersion;
        }
        if (r.plugin !== undefined) {
          // Single source of truth for the `descriptions[locale] ?? description`
          // fallback — same helper backs `/settings/plugins` (plugins.ts:88).
          resolved.pluginDescription = resolvePluginDescription(r.plugin, locale);
        }
        return resolved;
      });
      respond(res, 200, { contributions });
      return;
    }

    // GET /settings/contributions/:pluginId/assets/<path>
    const contributionPrefix = '/settings/contributions/';
    if (req.method === 'GET' && pathname.startsWith(contributionPrefix)) {
      const rest = pathname.slice(contributionPrefix.length);
      const segs = rest.split('/').filter(Boolean);
      const [rawPluginId, segAssets] = segs;
      if (segs.length >= 3 && rawPluginId !== undefined && segAssets === 'assets') {
        await serveAsset(deps, req, res, decodeURIComponent(rawPluginId), segs.slice(2).join('/'));
        return;
      }
    }

    // POST /settings/contributions/:pluginId/actions/:actionId
    const actionPrefix = contributionPrefix;
    if (req.method === 'POST' && pathname.startsWith(actionPrefix)) {
      const rest = pathname.slice(actionPrefix.length);
      const segs = rest.split('/').filter(Boolean);
      // Expected: [pluginId, 'actions', actionId]
      const [rawPluginId, segActions, rawActionId] = segs;
      if (
        segs.length !== 3 ||
        rawPluginId === undefined ||
        rawActionId === undefined ||
        segActions !== 'actions'
      ) {
        req.resume();
        respondError(res, 404, 'not_found', 'Unknown contributions route');
        return;
      }
      const pluginId = decodeURIComponent(rawPluginId);
      const actionId = decodeURIComponent(rawActionId);

      const reg = deps.pluginRegistry.getSettingsContribution(pluginId);
      if (reg === undefined) {
        respondError(res, 404, 'unknown_plugin', `Plugin "${pluginId}" not found`);
        return;
      }
      const descriptor = reg.contribution.actions?.find(
        (a: PluginActionDescriptor) => a.id === actionId,
      );
      if (descriptor === undefined) {
        respondError(
          res,
          404,
          'unknown_action',
          `Action "${actionId}" not declared on plugin "${pluginId}"`,
        );
        return;
      }
      const handler = reg.actionHandlers?.[actionId];
      if (handler === undefined) {
        respondError(
          res,
          500,
          'handler_missing',
          `No handler registered for ${pluginId}/${actionId}`,
        );
        return;
      }

      let config: GoldpanConfig;
      try {
        config = deps.getConfig();
      } catch (err) {
        deps.logger.error(`contributions: getConfig failed for ${pluginId}/${actionId}`, err);
        respond(res, 200, { ok: false, code: 'internal' });
        return;
      }

      const values = valuesFromEnv(reg);
      try {
        const bodyText = deps.readBody ? await deps.readBody(req, res) : await readRequestBody(req);
        if (bodyText === null) return;
        if (bodyText.trim().length > 0) {
          const parsed = JSON.parse(bodyText) as unknown;
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            respondError(res, 400, 'invalid_body', 'Request body must be an object');
            return;
          }
          const bodyValues = (parsed as { values?: unknown }).values;
          if (bodyValues !== undefined) {
            if (
              typeof bodyValues !== 'object' ||
              bodyValues === null ||
              Array.isArray(bodyValues)
            ) {
              respondError(res, 400, 'invalid_body', 'values must be an object');
              return;
            }
            const input = bodyValues as Record<string, unknown>;
            for (const field of reg.contribution.fields) {
              if (Object.hasOwn(input, field.name)) {
                const coerced = coerceFieldValue(field, input[field.name]);
                if (coerced === INVALID_FIELD_VALUE) {
                  respondError(res, 400, 'invalid_body', `Invalid value for "${field.name}"`);
                  return;
                }
                values[field.name] = coerced;
              }
            }
          }
        }
      } catch {
        respondError(res, 400, 'invalid_json', 'Invalid JSON body');
        return;
      }

      const parsedValues = reg.contribution.schema.safeParse(values);
      if (!parsedValues.success) {
        respond(res, 200, {
          ok: false,
          code: 'validation',
          message: parsedValues.error.issues[0]?.message ?? 'Invalid settings values',
        });
        return;
      }

      // AbortController-backed timeout — exposing `signal` to the handler so
      // `fetch(..., { signal })` actually cancels the underlying request when
      // the deadline fires. Without this the handler keeps running after we
      // respond, leaking the socket / fetch buffer until the upstream eventually
      // settles (Promise.race only decides which side resolves first).
      const abortController = new AbortController();
      // Per-action override falls back to the host default. Validated by the
      // contribution schema (1s..600s) so we can trust the number here.
      const handlerTimeoutMs = descriptor.timeoutMs ?? HANDLER_TIMEOUT_MS;
      let timeout!: () => void;
      const timeoutPromise = new Promise<typeof HANDLER_TIMEOUT>((resolve) => {
        timeout = () => {
          abortController.abort();
          resolve(HANDLER_TIMEOUT);
        };
      });
      const timer = setTimeout(timeout, handlerTimeoutMs);
      try {
        const raced = await Promise.race([
          handler({
            values: parsedValues.data,
            locale: config.language,
            logger: deps.logger as never,
            signal: abortController.signal,
          }),
          timeoutPromise,
        ]);
        if (raced === HANDLER_TIMEOUT) {
          deps.logger.error(`contributions: handler ${pluginId}/${actionId} timed out`, {
            timeoutMs: handlerTimeoutMs,
          });
          respond(res, 200, { ok: false, code: 'timeout' });
          return;
        }
        respond(res, 200, raced);
      } catch (err) {
        if (abortController.signal.aborted) {
          deps.logger.error(`contributions: handler ${pluginId}/${actionId} timed out`, {
            timeoutMs: handlerTimeoutMs,
          });
          respond(res, 200, { ok: false, code: 'timeout' });
          return;
        }
        deps.logger.error(`contributions: handler ${pluginId}/${actionId} threw`, {
          err: err instanceof Error ? err.message : String(err),
        });
        // SECURITY: never echo err.message — may contain secrets.
        respond(res, 200, { ok: false, code: 'internal' });
      } finally {
        clearTimeout(timer);
      }
      return;
    }

    req.resume();
    respondError(res, 404, 'not_found', 'Unknown contributions route');
  };
}
