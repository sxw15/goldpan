// apps/server/src/routes/sources.ts
import { discardSource } from '@goldpan/core/operations';
import { parseId, type RouteContext, respond, respondError } from './types.js';

const VALID_STATUSES = [
  'processing',
  'confirmed',
  'confirmed_empty',
  'failed',
  'discarded',
] as const;
const VALID_ORIGINS = ['user', 'tracking', 'github_refresh'] as const;
type ValidStatus = (typeof VALID_STATUSES)[number];
type ValidOrigin = (typeof VALID_ORIGINS)[number];

const isValidStatus = (s: string): s is ValidStatus =>
  (VALID_STATUSES as readonly string[]).includes(s);
const isValidOrigin = (s: string): s is ValidOrigin =>
  (VALID_ORIGINS as readonly string[]).includes(s);

export async function handleSourceRoutes(ctx: RouteContext): Promise<void> {
  const { req, res, segments, handle, url } = ctx;
  const { repos, db, config } = handle;

  // GET /sources — list
  if (req.method === 'GET' && segments.length === 0) {
    req.resume();
    try {
      const statusRaw = url.searchParams.get('status');
      let statusFilter: ValidStatus[] | undefined;
      if (statusRaw !== null) {
        const parts = statusRaw
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
        if (parts.length === 0) {
          respondError(res, 400, 'invalid_status', 'Invalid status');
          return;
        }
        for (const p of parts) {
          if (!isValidStatus(p)) {
            respondError(res, 400, 'invalid_status', 'Invalid status');
            return;
          }
        }
        // Repository.list() collapses single-element arrays to `eq()` itself;
        // route layer no longer needs the string-vs-array branching.
        statusFilter = parts as ValidStatus[];
      }
      const originRaw = url.searchParams.get('origin');
      if (originRaw !== null && !isValidOrigin(originRaw)) {
        respondError(res, 400, 'invalid_origin', 'Invalid origin');
        return;
      }
      const limitRaw = url.searchParams.get('limit');
      let limit: number | undefined;
      if (limitRaw !== null) {
        const parsed = Number.parseInt(limitRaw, 10);
        if (Number.isNaN(parsed) || parsed < 1 || parsed > 200) {
          respondError(res, 400, 'invalid_limit', 'limit must be 1-200');
          return;
        }
        limit = parsed;
      }

      const items = repos.source.list({
        status: statusFilter,
        origin: originRaw ?? undefined,
        limit,
      });
      const counts = repos.source.getStatusCounts();
      respond(res, 200, { data: items, total: items.length, counts });
    } catch (err) {
      handle.logger.error('GET /sources failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Internal error');
    }
    return;
  }

  // Below requires :id — parse only when segments[0] present
  const sourceId = parseId(segments[0]);
  if (sourceId === null) {
    req.resume();
    respondError(res, 400, 'invalid_id', 'Invalid source ID');
    return;
  }

  // GET /sources/:id — detail
  if (req.method === 'GET' && segments.length === 1) {
    req.resume();
    try {
      const detail = repos.source.getDetailWithEntities(sourceId);
      if (!detail) {
        respondError(res, 404, 'not_found', 'Source not found');
        return;
      }
      respond(res, 200, {
        source: {
          id: detail.source.id,
          kind: detail.source.kind,
          originalUrl: detail.source.originalUrl,
          normalizedUrl: detail.source.normalizedUrl,
          title: detail.source.title,
          status: detail.source.status,
          origin: detail.source.origin,
          createdAt: detail.source.createdAt,
          updatedAt: detail.source.updatedAt,
        },
        entities: detail.entities,
        entityCount: detail.entityCount,
      });
    } catch (err) {
      handle.logger.error(`GET /sources/${sourceId} failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Internal error');
    }
    return;
  }

  // POST /sources/:id/discard — unchanged
  if (req.method === 'POST' && segments.length === 2 && segments[1] === 'discard') {
    req.resume();
    try {
      const result = discardSource(sourceId, {
        db,
        repos,
        embeddingEnabled: config.embedding.enabled,
        logger: handle.logger,
      });
      if (!result.ok) {
        respondError(res, 404, result.code, 'Source not found or not discardable');
        return;
      }
      respond(res, 200, { ok: true });
    } catch (err) {
      handle.logger.error(`POST discard source ${sourceId} failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Discard failed');
    }
    return;
  }

  req.resume();
  respondError(res, 404, 'not_found', 'Not found');
}
