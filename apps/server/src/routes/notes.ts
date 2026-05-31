// apps/server/src/routes/notes.ts
import { parseId, type RouteContext, respond, respondError } from './types.js';

/**
 * Handle /notes/* routes.
 */
export async function handleNoteRoutes(ctx: RouteContext): Promise<void> {
  const { req, res, url, segments, handle } = ctx;
  const { repos } = handle;

  // GET /notes
  if (req.method === 'GET' && segments.length === 0) {
    req.resume();
    try {
      const categoryParam = url.searchParams.get('category');
      const notes = repos.sourceView.listSourceViewWithCategories();
      const allCategories = repos.category.getAll();
      const sourceViewStats = repos.sourceView.getSourceViewStats();
      const stats = {
        ...sourceViewStats,
        // Backward-compatible /notes HTTP contract. SDK types use sourceCount,
        // but direct curl/dashboard clients may still read the old field.
        noteCount: sourceViewStats.sourceCount,
      };

      const filtered = categoryParam
        ? notes.filter((n: { categoryIds: number[] }) =>
            n.categoryIds.includes(Number(categoryParam)),
          )
        : notes;

      respond(res, 200, {
        data: filtered,
        total: filtered.length,
        categories: allCategories,
        stats,
      });
    } catch (err) {
      handle.logger.error('GET /notes failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Internal error');
    }
    return;
  }

  // GET /notes/:sourceId
  if (req.method === 'GET' && segments.length === 1) {
    req.resume();
    const sourceId = parseId(segments[0]);
    if (sourceId === null) {
      respondError(res, 400, 'invalid_id', 'Invalid source ID');
      return;
    }

    try {
      const detail = repos.sourceView.getSourceViewDetail(sourceId);
      if (!detail) {
        respondError(res, 404, 'not_found', 'Note not found');
        return;
      }

      const tags = repos.sourceView.getSourceViewTags(sourceId);
      respond(res, 200, { ...detail, tags });
    } catch (err) {
      handle.logger.error(`GET /notes/${sourceId} failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Internal error');
    }
    return;
  }

  req.resume();
  respondError(res, 404, 'not_found', 'Not found');
}
