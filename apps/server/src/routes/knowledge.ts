// apps/server/src/routes/knowledge.ts
import { parseId, type RouteContext, respond, respondError } from './types.js';

/**
 * Handle /categories and /entities routes.
 */
export async function handleKnowledgeRoutes(
  ctx: RouteContext,
  prefix: 'categories' | 'entities',
): Promise<void> {
  const { req, res, handle } = ctx;
  const { repos } = handle;
  const segments = ctx.segments;

  if (prefix === 'categories') {
    // GET /categories
    if (req.method === 'GET' && segments.length === 0) {
      req.resume();
      try {
        const categories = repos.category.getAll();
        respond(res, 200, { data: categories, total: categories.length });
      } catch (err) {
        handle.logger.error('GET /categories failed', {
          err: err instanceof Error ? err.message : String(err),
        });
        respondError(res, 500, 'internal', 'Internal error');
      }
      return;
    }

    req.resume();
    respondError(res, 404, 'not_found', 'Not found');
    return;
  }

  // --- /entities routes ---

  // GET /entities — entity registry (list with active point counts)
  if (req.method === 'GET' && segments.length === 0) {
    req.resume();

    // P7.3: ?name=A&name=B short-circuit — returns lowercased-name → id map
    // for client-side mention lookup. Diverges from list-mode response
    // shape ({ data: [], total }) — when name/names is provided, response is
    // { data: Record<string, number> } so callers can't mix modes.
    //
    // `name` is repeated so entity names may contain commas. Keep the legacy
    // comma-joined `names=A,B` fallback for old callers while this PR is in
    // flight.
    const hasRepeatedNameParam = ctx.url.searchParams.has('name');
    const legacyNamesParam = ctx.url.searchParams.get('names');
    if (hasRepeatedNameParam || legacyNamesParam !== null) {
      const names = (
        hasRepeatedNameParam
          ? ctx.url.searchParams.getAll('name')
          : (legacyNamesParam ?? '').split(',')
      )
        .map((s) => s.trim())
        .filter(Boolean);
      try {
        const rows = repos.knowledge.findEntitiesByNames(names);
        const map: Record<string, number> = {};
        for (const r of rows) map[r.name.toLowerCase()] = r.id;
        respond(res, 200, { data: map });
      } catch (err) {
        handle.logger.error('GET /entities name lookup failed', {
          err: err instanceof Error ? err.message : String(err),
        });
        respondError(res, 500, 'internal', 'Internal error');
      }
      return;
    }

    try {
      const entityRegistry = repos.knowledge.getEntityRegistry();
      const categoryParam = ctx.url.searchParams.get('category');

      let filtered = entityRegistry;
      if (categoryParam) {
        const categoryId = parseInt(categoryParam, 10);
        if (!Number.isNaN(categoryId)) {
          const allCategories = repos.category.getAll();
          const selectedCategory = allCategories.find(
            (c: { id: number; path: string }) => c.id === categoryId,
          );
          if (selectedCategory) {
            filtered = entityRegistry.filter((e: { categoryPaths: string[] }) =>
              e.categoryPaths.some(
                (p: string) =>
                  p === selectedCategory.path || p.startsWith(`${selectedCategory.path}/`),
              ),
            );
          } else {
            filtered = [];
          }
        }
      }

      const data = filtered.map(
        (e: {
          id: number;
          name: string;
          categoryPaths: string[];
          activePointCount: number;
          createdAt: number;
        }) => ({
          id: e.id,
          name: e.name,
          categoryPaths: e.categoryPaths,
          activePointCount: e.activePointCount,
          createdAt: e.createdAt,
        }),
      );
      respond(res, 200, { data, total: data.length });
    } catch (err) {
      handle.logger.error('GET /entities failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Internal error');
    }
    return;
  }

  const entityId = parseId(segments[0]);
  if (entityId === null) {
    req.resume();
    respondError(res, 400, 'invalid_id', 'Invalid entity ID');
    return;
  }

  // GET /entities/:id — entity detail
  if (req.method === 'GET' && segments.length === 1) {
    req.resume();
    try {
      const entity = repos.knowledge.getEntityById(entityId);
      if (!entity) {
        respondError(res, 404, 'not_found', 'Entity not found');
        return;
      }

      const points = repos.knowledge.getActivePointsForEntity(entityId);
      const categoryPaths = repos.knowledge.getCategoryPathsForEntity(entityId);
      const sources = repos.knowledge.getSourcesForEntity(entityId);
      const relations = repos.knowledge.getRelationsForEntity(entityId);

      // Delegate github-source summarization to the plugin so all
      // `collector_github_*` key reads stay inside `@goldpan/plugin-github-collector`.
      interface GithubSummarizer {
        summarizeLatestGithubSource(rows: unknown[]): {
          owner: string;
          repo: string;
          normalizedUrl: string;
          archived: boolean;
          lastRefreshedAt: number | null;
        } | null;
      }
      const githubSvc = handle.pluginRegistry.getService<GithubSummarizer>('github');
      const githubRepo = githubSvc?.summarizeLatestGithubSource(sources as unknown[]) ?? null;

      const parseJsonArray = (raw: string): string[] => {
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed)
            ? parsed.filter((v: unknown): v is string => typeof v === 'string')
            : [];
        } catch {
          return [];
        }
      };

      respond(res, 200, {
        entity: {
          id: entity.id,
          name: entity.name,
          description: entity.description ?? null,
          descriptionTranslated: entity.descriptionTranslated ?? null,
          aliases: parseJsonArray(entity.aliases),
          keywords: parseJsonArray(entity.keywords),
          categoryPaths,
        },
        points: points.map(
          (p: {
            id: number;
            content: string;
            contentTranslated: string | null;
            type: string;
            status: string;
            createdAt: number;
          }) => ({
            id: p.id,
            content: p.content,
            contentTranslated: p.contentTranslated ?? null,
            type: p.type,
            status: p.status,
            createdAt: p.createdAt,
          }),
        ),
        sources: sources.map((s: { id: number; originalUrl: string | null; status: string }) => ({
          id: s.id,
          originalUrl: s.originalUrl,
          status: s.status,
        })),
        relations: relations.map(
          (r: {
            id: number;
            sourceEntityId: number;
            targetEntityId: number;
            sourceEntityName: string;
            targetEntityName: string;
            relationType: string;
            description: string;
            descriptionTranslated: string | null;
          }) => ({
            id: r.id,
            sourceEntityId: r.sourceEntityId,
            targetEntityId: r.targetEntityId,
            sourceEntityName: r.sourceEntityName,
            targetEntityName: r.targetEntityName,
            relationType: r.relationType,
            description: r.description,
            descriptionTranslated: r.descriptionTranslated ?? null,
          }),
        ),
        githubRepo,
      });
    } catch (err) {
      handle.logger.error(`GET /entities/${entityId} failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
      respondError(res, 500, 'internal', 'Internal error');
    }
    return;
  }

  req.resume();
  respondError(res, 404, 'not_found', 'Not found');
}
