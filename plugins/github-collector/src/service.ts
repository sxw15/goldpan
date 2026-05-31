import type { DrizzleDB } from '@goldpan/core/db';
import { processingTasks, sources } from '@goldpan/core/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { buildNormalizedUrl } from './parser.js';

export type RefreshResult =
  | { status: 'started'; sourceId: number; taskId: number }
  | { status: 'in_progress'; sourceId: number; taskId: number; startedAt: number }
  | { status: 'too_recent'; retryAfterSeconds: number; lastRefreshedAt: number }
  | { status: 'rate_limited'; resetsAt: number }
  | { status: 'not_found' }
  | { status: 'archived'; archivedAt: number | null };

export interface RepoState {
  normalizedUrl: string;
  refreshCount: number;
  lastRefreshedAt: number | null;
  lastCommitSha: string | null;
  lastReleaseTag: string | null;
  archived: boolean;
}

/** Row shape the knowledge repo already returns for entity sources. */
export interface EntitySourceRow {
  metadata: string | null;
  normalizedUrl: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface GithubRepoSummary {
  owner: string;
  repo: string;
  normalizedUrl: string;
  archived: boolean;
  lastRefreshedAt: number | null;
}

export class GithubService {
  constructor(
    private readonly deps: {
      db: DrizzleDB;
      cooldownSec: number;
    },
  ) {}

  refreshRepo(args: { owner: string; repo: string }): Promise<RefreshResult> {
    return this.refreshRepoByNormalizedUrl(buildNormalizedUrl(args.owner, args.repo));
  }

  async refreshRepoByNormalizedUrl(normalizedUrl: string): Promise<RefreshResult> {
    const { db, cooldownSec } = this.deps;

    // 1. Archived pre-check (readonly)
    const lastConfirmed = db
      .select({ metadata: sources.metadata })
      .from(sources)
      .where(
        and(
          eq(sources.normalizedUrl, normalizedUrl),
          inArray(sources.status, ['confirmed', 'confirmed_empty']),
        ),
      )
      .orderBy(desc(sources.id))
      .limit(1)
      .get();
    if (lastConfirmed?.metadata) {
      const meta = parseMetadata(lastConfirmed.metadata);
      if (meta.collector_github_archived === true) {
        const at =
          typeof meta.collector_github_archived_at === 'string'
            ? toMsOrNull(meta.collector_github_archived_at)
            : null;
        return { status: 'archived', archivedAt: at };
      }
    }

    // 2. Cooldown + terminal-failure short-circuit
    const lastAttempt = db
      .select({
        id: sources.id,
        createdAt: sources.createdAt,
        status: sources.status,
        metadata: sources.metadata,
      })
      .from(sources)
      .where(
        and(
          eq(sources.normalizedUrl, normalizedUrl),
          inArray(sources.status, ['confirmed', 'confirmed_empty', 'failed']),
        ),
      )
      .orderBy(desc(sources.id))
      .limit(1)
      .get();
    if (lastAttempt) {
      const createdAt = toMs(lastAttempt.createdAt);
      const elapsedSec = (Date.now() - createdAt) / 1000;
      // Terminal-failure short-circuit is scoped to the cooldown window so a
      // transient permission/visibility problem cannot permanently poison a
      // normalizedUrl. Past the cooldown, fall through to insert a new task.
      if (elapsedSec < cooldownSec) {
        if (lastAttempt.status === 'failed') {
          const meta = parseMetadata(lastAttempt.metadata);
          const code =
            typeof meta.collector_failure_code === 'string' ? meta.collector_failure_code : null;
          if (code === 'not_found') return { status: 'not_found' };
        }
        return {
          status: 'too_recent',
          retryAfterSeconds: Math.ceil(cooldownSec - elapsedSec),
          lastRefreshedAt: createdAt,
        };
      }
    }

    // 3. In-progress check (cross-origin)
    const inFlight = db
      .select({
        id: sources.id,
        taskId: processingTasks.id,
        createdAt: sources.createdAt,
      })
      .from(sources)
      .innerJoin(processingTasks, eq(processingTasks.sourceId, sources.id))
      .where(and(eq(sources.normalizedUrl, normalizedUrl), eq(sources.status, 'processing')))
      .orderBy(desc(sources.id))
      .limit(1)
      .get();
    if (inFlight) {
      return {
        status: 'in_progress',
        sourceId: inFlight.id,
        taskId: inFlight.taskId,
        startedAt: toMs(inFlight.createdAt),
      };
    }

    // 4. Insert source + task
    try {
      return db.transaction((tx) => {
        const sourceRow = tx
          .insert(sources)
          .values({
            kind: 'external',
            originalUrl: normalizedUrl,
            normalizedUrl,
            origin: 'github_refresh',
            status: 'processing',
          })
          .returning({ id: sources.id })
          .get();
        const taskRow = tx
          .insert(processingTasks)
          .values({ sourceId: sourceRow.id, type: 'pipeline', status: 'pending' })
          .returning({ id: processingTasks.id })
          .get();
        return { status: 'started' as const, sourceId: sourceRow.id, taskId: taskRow.id };
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const raced = db
          .select({
            id: sources.id,
            taskId: processingTasks.id,
            createdAt: sources.createdAt,
          })
          .from(sources)
          .innerJoin(processingTasks, eq(processingTasks.sourceId, sources.id))
          .where(
            and(
              eq(sources.normalizedUrl, normalizedUrl),
              eq(sources.status, 'processing'),
              eq(sources.origin, 'github_refresh'),
            ),
          )
          .orderBy(desc(sources.id))
          .limit(1)
          .get();
        if (raced) {
          return {
            status: 'in_progress',
            sourceId: raced.id,
            taskId: raced.taskId,
            startedAt: toMs(raced.createdAt),
          };
        }
      }
      throw err;
    }
  }

  /**
   * Given the entity's source rows (already fetched by the caller), pick the
   * most recently updated github-collector source and extract the summary
   * fields. All `collector_github_*` key names stay inside this module.
   */
  summarizeLatestGithubSource(rows: EntitySourceRow[]): GithubRepoSummary | null {
    const githubRows = rows.filter((s) => {
      if (typeof s.metadata !== 'string') return false;
      try {
        const meta = JSON.parse(s.metadata) as Record<string, unknown> | null;
        return !!meta && meta.collectorPlugin === 'collector-github';
      } catch {
        return false;
      }
    });
    if (githubRows.length === 0) return null;
    // `createdAt`/`updatedAt` are epoch milliseconds (sqlite `integer` columns);
    // numeric comparison yields the right chronological order.
    const latest = githubRows.reduce((acc, cur) =>
      (cur.updatedAt ?? cur.createdAt ?? 0) > (acc.updatedAt ?? acc.createdAt ?? 0) ? cur : acc,
    );
    const meta = parseMetadata(latest.metadata);
    return {
      owner: typeof meta.collector_github_owner === 'string' ? meta.collector_github_owner : '',
      repo: typeof meta.collector_github_repo === 'string' ? meta.collector_github_repo : '',
      normalizedUrl: latest.normalizedUrl ?? '',
      archived: meta.collector_github_archived === true,
      lastRefreshedAt: latest.updatedAt ?? latest.createdAt ?? null,
    };
  }

  getRepoState(args: { owner: string; repo: string }): RepoState | null {
    const normalizedUrl = buildNormalizedUrl(args.owner, args.repo);
    const latest = this.deps.db
      .select({
        metadata: sources.metadata,
        createdAt: sources.createdAt,
      })
      .from(sources)
      .where(
        and(
          eq(sources.normalizedUrl, normalizedUrl),
          inArray(sources.status, ['confirmed', 'confirmed_empty']),
        ),
      )
      .orderBy(desc(sources.id))
      .limit(1)
      .get();
    if (!latest) return null;
    const meta = parseMetadata(latest.metadata);
    const countRow = this.deps.db
      .select({ c: sql<number>`count(*)` })
      .from(sources)
      .where(eq(sources.normalizedUrl, normalizedUrl))
      .get();
    const count = countRow?.c ?? 0;
    return {
      normalizedUrl,
      refreshCount: count,
      lastRefreshedAt: toMs(latest.createdAt),
      lastCommitSha:
        typeof meta.collector_github_last_commit_sha === 'string'
          ? meta.collector_github_last_commit_sha
          : null,
      lastReleaseTag:
        typeof meta.collector_github_last_release_tag === 'string'
          ? meta.collector_github_last_release_tag
          : null,
      archived: meta.collector_github_archived === true,
    };
  }
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

function toMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Date.parse(String(value));
}

function toMsOrNull(value: unknown): number | null {
  const ms = toMs(value);
  return Number.isFinite(ms) ? ms : null;
}
