// Handler for /tracking/* HTTP routes. Mirrors the per-family route modules
// (sources.ts, notes.ts, digest.ts) and uses the duck-typed InterestServiceAPI
// so main.ts does not need to import the plugin's concrete TrackingService
// type. Service methods are named getInterests / createInterest / etc., while
// the HTTP paths remain /tracking/rules/* for URL-stability with older clients.

import { getRawDatabase } from '@goldpan/core/db';
import { t } from '@goldpan/core/i18n';
import { isContributionRuntimeReady } from '@goldpan/core/plugins';
import { z } from 'zod';
import {
  parseId,
  parseJsonBody,
  parsePositiveIntParam,
  type RouteContext,
  respond,
  respondError,
} from './types.js';

/**
 * Route-level shape validation (mirrors digest.ts pattern). Deep semantic
 * rules — trim, length caps, toolProvider resolution, dedup, joined-query
 * length ≤500 — live in `TrackingCrudService.validateSearchQueries` and its
 * callers and surface as `TrackingServiceError('validation_error', …)`. The
 * schemas below only block wrong *types* (e.g. `name: 123`, `searchQueries:
 * 'not-an-array'`, `intervalMinutes: '60'`) from reaching the service layer
 * where `better-sqlite3` would reject non-number bindings with a
 * `TypeError` that surfaces as an opaque 500.
 */
const CreateInterestSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  searchQueries: z.array(z.string()),
  intervalMinutes: z.number().int().optional(),
  linkedEntityIds: z.array(z.number().int().positive()).optional(),
  toolProvider: z.string().optional(),
  enabled: z.boolean().optional(),
});

const UpdateInterestSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    searchQueries: z.array(z.string()),
    intervalMinutes: z.number().int(),
    linkedEntityIds: z.array(z.number().int().positive()),
    toolProvider: z.string(),
  })
  .partial();

/**
 * Duck-typed plugin API surface for the tracking service. Keeping it
 * self-contained here avoids a compile-time import of
 * `@goldpan/plugin-tracking` into the server (plugins are loaded at runtime
 * from plugin dist folders). Field-level drift is caught by the HTTP shape
 * tests in `apps/server/tests/routes/tracking.test.ts` (key-set assertions)
 * plus the plugin-level shape tests from T1.
 */
interface InterestStatsLike {
  totalHits: number;
  newHits24h: number;
  ingestedTotal: number;
  sparkline: number[];
}

interface InterestServiceAPI {
  getInterests(): Array<{ id: number; linkedEntityIds: number[] } & Record<string, unknown>>;
  /**
   * Optional in the duck-type so older plugin builds without
   * `getInterestListStats` still satisfy the surface — handler logs a
   * one-shot warning when the method is missing so a stats-zeroed list is
   * never invisible at runtime. Drift also caught by the plugin-level
   * shape test in T1.
   */
  getInterestListStats?: () => Map<number, InterestStatsLike>;
  getInterest(
    id: number,
  ): ({ id: number; linkedEntityIds: number[] } & Record<string, unknown>) | undefined;
  createInterest(data: Record<string, unknown>): { id: number } & Record<string, unknown>;
  updateInterest(id: number, data: Record<string, unknown>): Record<string, unknown>;
  deleteInterest(id: number): void;
  enableInterest(id: number): Record<string, unknown>;
  disableInterest(id: number): Record<string, unknown>;
  triggerExecution(id: number): void;
  getExecution(
    id: number,
  ):
    | ({ items?: Array<{ sourceId?: number | null } & Record<string, unknown>> } & Record<
        string,
        unknown
      >)
    | undefined;
  getInterestExecutions(
    id: number,
    options?: { page?: number; perPage?: number },
  ): { executions: Array<Record<string, unknown>>; total: number };
  /**
   * P4 deferred resolver write — also used by the UI clarify-chip path
   * (`POST /tracking/rules/:id/resolve`) to promote `awaiting_clarify` rows
   * to `resolved` after the user picks an entity. CAS via `expectedStatus`
   * is what guards against the resolver / clarify cron / chip click race.
   */
  markResolved(
    id: number,
    input: {
      name: string;
      searchQueries: string[];
      linkedEntityIds: number[];
      expectedStatus:
        | 'resolved'
        | 'pending_pipeline'
        | 'awaiting_clarify'
        | 'failed_no_entity'
        | 'failed_source_pipeline';
    },
  ): boolean;
}

function isTrackingServiceError(err: unknown): err is { code: string; message: string } {
  return (
    err instanceof Error &&
    err.name === 'TrackingServiceError' &&
    'code' in err &&
    typeof (err as Record<string, unknown>).code === 'string'
  );
}

function errStatus(code: string): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'validation_error':
    case 'invalid_provider':
      return 400;
    default:
      return 500;
  }
}

/**
 * Read + parse JSON object body. Returns `null` if the response has already
 * been sent (413 too_large, 400 invalid_json, or 400 validation_error for
 * non-object bodies). Reuses the central `parseJsonBody` so we don't grow
 * a third implementation of JSON body parsing (see CLAUDE.md §3 defense
 * discipline — central point reuse over consumer-side duplication).
 */
async function readJsonObjectBody(ctx: RouteContext): Promise<Record<string, unknown> | null> {
  const raw = await ctx.readBody();
  if (raw === null) return null;
  const parsed = parseJsonBody<unknown>(ctx.res, raw);
  if (parsed === null) return null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    respondError(ctx.res, 400, 'validation_error', 'Request body must be a JSON object');
    return null;
  }
  return parsed as Record<string, unknown>;
}

function listLinkedEntities(
  ctx: RouteContext,
  ids: number[],
): Array<{ id: number; name: string; categoryPaths: string[] }> {
  if (ids.length === 0) return [];
  // Reuse the existing KnowledgeRepository.getEntitiesByIds (single JOIN that
  // already assembles name + categoryPaths + aliases + keywords). No new repo
  // method needed — see packages/core/src/db/repositories/knowledge.repository.ts:257.
  const entities = ctx.handle.repos.knowledge.getEntitiesByIds(ids);
  return entities.map((e: { id: number; name: string; categoryPaths: string[] }) => ({
    id: e.id,
    name: e.name,
    categoryPaths: e.categoryPaths,
  }));
}

/**
 * Handle /tracking/* routes. Auth is enforced by the caller (main.ts) before
 * dispatching — this handler assumes credentials have already been verified.
 * Returns 404 `not_found` with message "Tracking plugin is not loaded" when
 * the tracking plugin is not registered (see .agent/server-api.md §Tracking).
 */
export async function handleTrackingRoutes(ctx: RouteContext): Promise<void> {
  const { req, res, url, segments, handle } = ctx;

  // GET /tracking/search-tool-status
  // Probes the plugin registry for any tool plugin that registered a `search`
  // tool AND is *runtime-ready* — i.e. its enable toggle (if any) is on and
  // every secret field is filled. The front-end shows a "configure first"
  // banner when this returns `configured: false`, so the answer must reflect
  // whether the rule can actually execute, not just whether the plugin code is
  // loaded. `listToolCandidates` only checks registration; we filter further
  // with `isContributionRuntimeReady` against `process.env` (the same source
  // each plugin's executeTool reads from).
  //
  // The tracking plugin itself is not required to be loaded: the front-end
  // calls this *before* it can sensibly let users author rules, so a 404
  // "tracking plugin not loaded" would block the warning we are trying to
  // surface. Auth still applies (caller in main.ts gates with authRequired()).
  if (req.method === 'GET' && segments.length === 1 && segments[0] === 'search-tool-status') {
    req.resume();
    const candidates = handle.pluginRegistry.listToolCandidates('search');
    const usable = candidates.filter(
      (c: {
        plugin: { settingsContribution?: Parameters<typeof isContributionRuntimeReady>[0] };
      }) => {
        const contribution = c.plugin.settingsContribution;
        // No contribution = no declared config requirements, so the plugin is
        // assumed always-usable. None of the bundled search plugins fall in
        // this bucket today; this branch keeps the helper forgiving for
        // third-party plugins that don't ship a contribution.
        if (!contribution) return true;
        return isContributionRuntimeReady(contribution);
      },
    );
    const providers = usable.map((c: { plugin: { name: string } }) => c.plugin.name);
    respond(res, 200, { configured: providers.length > 0, providers });
    return;
  }

  const service = handle.pluginRegistry.getService<InterestServiceAPI>('tracking');
  if (!service) {
    req.resume();
    // SDK/web callers discriminate 404 "plugin not loaded" from 404
    // "resource not found" by matching this exact code+message pair plus the
    // path shape; keep both stable.
    respondError(res, 404, 'not_found', 'Tracking plugin is not loaded');
    return;
  }

  try {
    // /tracking/rules[...]
    if (segments[0] === 'rules') {
      // GET /tracking/rules
      if (req.method === 'GET' && segments.length === 1) {
        req.resume();
        const interests = service.getInterests();
        // Stats are batched in the plugin via two GROUP-BY queries (avoids
        // N+1 round-trips when rendering the rule list). Missing entries
        // (interests with zero executions) are zero-filled here so the SDK
        // contract has every list item defined — front-end relies on the
        // 14-element sparkline length for fixed-width rendering.
        let statsMap: Map<number, InterestStatsLike>;
        if (service.getInterestListStats) {
          statsMap = service.getInterestListStats();
        } else {
          // An older / mismatched plugin build is a configuration bug, not a
          // runtime fallback to silently swallow — log loud so deployers see
          // it even though we still serve the route to keep the page useful.
          handle.logger.warn(
            'tracking: getInterestListStats missing — list stats will be zero-filled. Rebuild @goldpan/plugin-tracking.',
          );
          statsMap = new Map<number, InterestStatsLike>();
        }
        const dataWithCount = interests.map(
          (i: { id: number; linkedEntityIds: number[] } & Record<string, unknown>) => {
            const stats = statsMap.get(i.id);
            return {
              ...i,
              linkedEntityCount: Array.isArray(i.linkedEntityIds) ? i.linkedEntityIds.length : 0,
              totalHits: stats?.totalHits ?? 0,
              newHits24h: stats?.newHits24h ?? 0,
              ingestedTotal: stats?.ingestedTotal ?? 0,
              // Fresh array per row — never share the zero-fill reference,
              // so a future caller mutating `sparkline` cannot bleed across
              // interests. Cheap (14 numbers) and removes a foot-gun.
              sparkline: stats?.sparkline ?? Array(14).fill(0),
            };
          },
        );
        respond(res, 200, { data: dataWithCount, total: dataWithCount.length });
        return;
      }

      // POST /tracking/rules
      if (req.method === 'POST' && segments.length === 1) {
        const body = await readJsonObjectBody(ctx);
        if (body === null) return;
        const parsed = CreateInterestSchema.safeParse(body);
        if (!parsed.success) {
          respondError(res, 400, 'validation_error', parsed.error.message);
          return;
        }
        const interest = service.createInterest(parsed.data);
        respond(res, 201, { data: interest });
        return;
      }

      // /tracking/rules/:id[...]
      if (segments.length >= 2) {
        const id = parseId(segments[1]);
        if (id === null) {
          req.resume();
          respondError(res, 400, 'invalid_id', 'Invalid interest ID');
          return;
        }

        // GET /tracking/rules/:id → InterestDetail
        if (req.method === 'GET' && segments.length === 2) {
          req.resume();
          const interest = service.getInterest(id);
          if (!interest) {
            respondError(res, 404, 'not_found', 'Interest not found');
            return;
          }
          const linkedEntities = listLinkedEntities(ctx, interest.linkedEntityIds ?? []);
          const { executions: recentExecutions } = service.getInterestExecutions(id, {
            page: 1,
            perPage: 5,
          });
          respond(res, 200, {
            data: { interest, linkedEntities, recentExecutions },
          });
          return;
        }

        // PUT /tracking/rules/:id
        if (req.method === 'PUT' && segments.length === 2) {
          const body = await readJsonObjectBody(ctx);
          if (body === null) return;
          const parsed = UpdateInterestSchema.safeParse(body);
          if (!parsed.success) {
            respondError(res, 400, 'validation_error', parsed.error.message);
            return;
          }
          const updated = service.updateInterest(id, parsed.data);
          respond(res, 200, { data: updated });
          return;
        }

        // DELETE /tracking/rules/:id
        if (req.method === 'DELETE' && segments.length === 2) {
          req.resume();
          service.deleteInterest(id);
          res.writeHead(204);
          res.end();
          return;
        }

        // POST /tracking/rules/:id/{enable|disable|run}
        if (req.method === 'POST' && segments.length === 3) {
          const op = segments[2];
          // resolve is the only POST :id/op that reads a body; enable/disable/run
          // resume the request stream before doing anything else.
          if (op === 'resolve') {
            const body = await readJsonObjectBody(ctx);
            if (body === null) return;
            const entityIdRaw = body.entityId;
            if (
              typeof entityIdRaw !== 'number' ||
              !Number.isInteger(entityIdRaw) ||
              entityIdRaw <= 0
            ) {
              respondError(res, 400, 'invalid_entity_id', 'entityId must be a positive integer');
              return;
            }
            const entityId = entityIdRaw;

            // Interest row state + pending_resolution live in the plugin's
            // tracking_rules table; the public InterestService surface does not
            // expose them (resolution_status is plugin-internal). Raw SQL here
            // keeps us off a one-off service method for a single read path.
            // `service.markResolved` still owns the CAS write.
            const rawDb = getRawDatabase(handle.db);
            const stateRow = rawDb
              .prepare(
                `SELECT resolution_status, pending_resolution
                 FROM tracking_rules
                 WHERE id = ?`,
              )
              .get(id) as
              | { resolution_status: string; pending_resolution: string | null }
              | undefined;
            if (!stateRow) {
              respondError(res, 404, 'rule_not_found', `Rule #${id} not found`);
              return;
            }
            if (stateRow.resolution_status !== 'awaiting_clarify') {
              respondError(
                res,
                409,
                'invalid_status',
                `Rule must be in awaiting_clarify, got: ${stateRow.resolution_status}`,
              );
              return;
            }
            const payload = stateRow.pending_resolution
              ? (JSON.parse(stateRow.pending_resolution) as {
                  candidateEntityIds?: number[];
                  conversationId?: number;
                })
              : null;
            const candidates = payload?.candidateEntityIds ?? [];
            if (!candidates.includes(entityId)) {
              respondError(res, 400, 'invalid_entity_id', 'entityId not in candidate list');
              return;
            }

            const entity = handle.repos.knowledge.getEntitiesByIds([entityId])[0];
            const entityName = entity?.name ?? `entity ${entityId}`;
            const ok = service.markResolved(id, {
              name: entityName,
              searchQueries: [entityName],
              linkedEntityIds: [entityId],
              expectedStatus: 'awaiting_clarify',
            });
            if (!ok) {
              // CAS lost — the clarify-timeout watcher (or another tab) already
              // finalized this row. Re-fetching just to surface a "current
              // status" would race the next finalize and is noise; the client
              // should refetch the rule itself.
              respondError(res, 409, 'race_conflict', 'Rule was just transitioned by another path');
              return;
            }

            // Mirror the deferredResolver's pushAssistant policy: archived
            // conversations are web-only "user reset" rows — re-appending a
            // turn there is invisible to the active list and feels like the
            // message vanished. IM channels never archive, so this guard only
            // bites the web origin path. Conversation id 0 / missing means
            // CLI origin (no persistent conversation to write to).
            const conversationId = payload?.conversationId;
            if (typeof conversationId === 'number' && conversationId > 0) {
              try {
                const conv = handle.repos.conversation.loadConversationById(conversationId);
                if (conv?.archivedAt) {
                  handle.logger.info('tracking resolve: assistant turn skipped, conv archived', {
                    conversationId,
                    ruleId: id,
                  });
                } else {
                  handle.repos.conversation.appendMessage(conversationId, {
                    role: 'assistant',
                    content: t('tracking.resolved_assistant_text', { name: entityName }),
                    metadata: {
                      resultType: 'action',
                      actionId: `tracking-${id}-resolved`,
                      trackingRuleId: id,
                    },
                  });
                }
              } catch (err) {
                handle.logger.warn('tracking resolve: appendMessage failed', {
                  err: err instanceof Error ? err.message : String(err),
                });
              }
            }

            respond(res, 200, { resolved: true, ruleId: id, entityId, entityName });
            return;
          }

          req.resume();
          if (op === 'enable') {
            const data = service.enableInterest(id);
            respond(res, 200, { data });
            return;
          }
          if (op === 'disable') {
            const data = service.disableInterest(id);
            respond(res, 200, { data });
            return;
          }
          if (op === 'run') {
            if (!handle.config.tracking.schedulerEnabled) {
              respondError(
                res,
                409,
                'scheduler_disabled',
                'Tracking scheduler is not enabled — set GOLDPAN_TRACKING_SCHEDULER_ENABLED=true',
              );
              return;
            }
            service.triggerExecution(id);
            respond(res, 202, {
              triggered: true,
              message: `Execution triggered for interest ${id}`,
            });
            return;
          }
        }

        // GET /tracking/rules/:id/executions
        if (req.method === 'GET' && segments[2] === 'executions' && segments.length === 3) {
          req.resume();
          const rawPage = url.searchParams.get('page');
          const rawPerPage = url.searchParams.get('perPage');
          // Absent params use defaults; present-but-malformed values (non-int,
          // fractional, Infinity, NaN, negative) return 400 rather than
          // silently flooring. Previously Number('1.5') = 1.5 reached
          // better-sqlite3 as a LIMIT/OFFSET binding and raised an opaque 500.
          const page = rawPage === null ? 1 : parsePositiveIntParam(rawPage);
          const perPageParsed = rawPerPage === null ? 30 : parsePositiveIntParam(rawPerPage);
          if (page === null || perPageParsed === null) {
            respondError(
              res,
              400,
              'validation_error',
              'page and perPage must be positive integers',
            );
            return;
          }
          const perPage = Math.min(100, perPageParsed);
          const { executions, total } = service.getInterestExecutions(id, { page, perPage });
          respond(res, 200, { data: executions, total, page, perPage });
          return;
        }
      }
    }

    // GET /tracking/executions/:id — strip sourceId from each item (kept for
    // the web/SDK clients; they don't receive raw source DB IDs).
    if (req.method === 'GET' && segments[0] === 'executions' && segments.length === 2) {
      req.resume();
      const execId = parseId(segments[1]);
      if (execId === null) {
        respondError(res, 400, 'invalid_id', 'Invalid execution ID');
        return;
      }
      const execution = service.getExecution(execId);
      if (!execution) {
        respondError(res, 404, 'not_found', 'Execution not found');
        return;
      }
      const sanitized = {
        ...execution,
        items: Array.isArray(execution.items)
          ? execution.items.map(
              ({
                sourceId: _sourceId,
                ...rest
              }: { sourceId?: number | null } & Record<string, unknown>) => rest,
            )
          : execution.items,
      };
      respond(res, 200, { data: sanitized });
      return;
    }

    req.resume();
    respondError(res, 404, 'not_found', 'Not found');
  } catch (err) {
    if (isTrackingServiceError(err)) {
      respondError(res, errStatus(err.code), err.code, err.message);
      return;
    }
    handle.logger.error('tracking route error', {
      err: err instanceof Error ? err.message : String(err),
    });
    respondError(res, 500, 'internal', 'Internal error');
  }
}
